// Run:  npm i express socket.io   then   node server.js   -> open http://localhost:3000 (index.html must sit next to this file)
const express=require('express'),http=require('http'),{Server}=require('socket.io');
const app=express(),srv=http.createServer(app),io=new Server(srv,{cors:{origin:'*'}});
app.use(express.static(__dirname));
const BASE={blue:-3600,red:3600},MATCH=300,TOTAL=36,PT_BLD=10,PT_KILL=100,rooms=new Map();
const fin=(...a)=>a.every(Number.isFinite),other=t=>t==='blue'?'red':'blue';
const norm=v=>{const l=Math.hypot(...v)||1;return v.map(x=>x/l)};
// nose points toward -Z in the client, so forward is (0,0,-1) rotated by the jet quaternion
const rot=(q,[x,y,z])=>{const ix=q.qw*x+q.qy*z-q.qz*y,iy=q.qw*y+q.qz*x-q.qx*z,iz=q.qw*z+q.qx*y-q.qy*x,iw=-q.qx*x-q.qy*y-q.qz*z;
 return[ix*q.qw+iw*-q.qx+iy*-q.qz-iz*-q.qy,iy*q.qw+iw*-q.qy+iz*-q.qx-ix*-q.qz,iz*q.qw+iw*-q.qz+ix*-q.qy-iy*-q.qx]};
const fwd=s=>fin(s.fx,s.fy,s.fz)?norm([s.fx,s.fy,s.fz]):norm(rot(s,[0,0,-1]));
const pts=(r,t)=>r.dead[other(t)].size*PT_BLD+r.kills[t]*PT_KILL;
function newRoom(){let c;do c=Math.random().toString(36).slice(2,8).toUpperCase();while(rooms.has(c));
 const r={code:c,players:new Map(),projs:[],pid:0,left:MATCH,started:false,over:false,winner:null,resetAt:0,dead:{blue:new Set(),red:new Set()},kills:{blue:0,red:0}};rooms.set(c,r);return r}
const roster=r=>[...r.players.values()].map(p=>({id:p.id,name:p.name,team:p.team,state:p.state}));
function join(sock,r,name){if(r.players.size>=8)return sock.emit('roomError',{message:'Room is full'});
 const n=t=>[...r.players.values()].filter(p=>p.team===t).length,team=n('blue')<=n('red')?'blue':'red';
 const p={id:sock.id,name:String(name||'Pilot').slice(0,16),team,state:null,hp:100,dead:false,deadAt:0,kills:0,deaths:0,gun:false,gc:0,mc:0};
 r.players.set(sock.id,p);sock.join(r.code);sock.data.room=r.code;
 sock.emit(r.players.size===1?'roomCreated':'roomJoined',{code:r.code,team,count:r.players.size,players:roster(r)});
 sock.to(r.code).emit('playerJoined',{id:p.id,name:p.name,team});io.to(r.code).emit('roomCount',{count:r.players.size})}
const spawnMsg=p=>({id:p.id,name:p.name,team:p.team,x:BASE[p.team],y:1.95,z:1120});
function hit(r,t,owner,dmg,weapon){if(t.dead)return;t.hp-=dmg;io.to(r.code).emit('combatEvent',{targetId:t.id,shooterId:owner?.id,weapon});
 if(t.hp<=0){t.hp=0;t.dead=true;t.deadAt=Date.now();t.deaths++;if(owner&&owner.team!==t.team){owner.kills++;r.kills[owner.team]++}}}
io.on('connection',sock=>{
 const R=()=>rooms.get(sock.data.room),P=()=>R()?.players.get(sock.id);
 sock.on('createRoom',d=>join(sock,newRoom(),d?.name));
 sock.on('joinRoom',d=>{const r=rooms.get(String(d?.code||'').toUpperCase());r?join(sock,r,d.name):sock.emit('roomError',{message:'Room not found'})});
 sock.on('playerState',d=>{const p=P();if(!p||!d||!fin(d.x,d.y,d.z,d.qx,d.qy,d.qz,d.qw))return;
  p.state={x:d.x,y:d.y,z:d.z,vx:+d.vx||0,vy:+d.vy||0,vz:+d.vz||0,qx:d.qx,qy:d.qy,qz:d.qz,qw:d.qw,fx:d.fx,fy:d.fy,fz:d.fz};p.gun=!!d.gun;
  sock.to(sock.data.room).emit('playerState',{id:p.id,name:p.name,team:p.team,state:{...p.state,hp:p.hp,dead:p.dead}})});
 sock.on('fireWeapon',d=>{const r=R(),p=P();if(!r||!p||p.dead||!p.state||d?.weapon!=='missile'||Date.now()-p.mc<2000)return;
  const t=r.players.get(d.targetId);if(!t||t.dead||t.team===p.team||!t.state)return;p.mc=Date.now();
  const f=fwd(p.state),id=++r.pid,m={id,type:'missile',owner:p.id,team:p.team,tid:t.id,x:p.state.x+f[0]*9,y:p.state.y+f[1]*9,z:p.state.z+f[2]*9,v:[f[0]*320+p.state.vx,f[1]*320+p.state.vy,f[2]*320+p.state.vz],life:20};
  r.projs.push(m);io.to(r.code).emit('projectileSpawn',{id,weapon:'missile',team:p.team,x:m.x,y:m.y,z:m.z,vx:m.v[0],vy:m.v[1],vz:m.v[2]})});
 sock.on('crashRequest',()=>{const r=R(),p=P();if(r&&p&&!p.dead){p.hp=0;p.dead=true;p.deadAt=Date.now();p.deaths++}});
 sock.on('respawnRequest',()=>{});
 sock.on('cityDestroyed',d=>{const r=R(),p=P();if(!r||!p||r.over||!r.started||!['blue','red'].includes(d?.team)||d.team===p.team||!Number.isInteger(d.cid)||d.cid<0||d.cid>=TOTAL||r.dead[d.team].has(d.cid))return;
  r.dead[d.team].add(d.cid);sock.to(r.code).emit('cityDestroyed',{team:d.team,cid:d.cid})});
 sock.on('disconnect',()=>{const r=R(),p=P();if(!r||!p)return;r.players.delete(sock.id);io.to(r.code).emit('playerLeft',{id:sock.id,name:p.name});
  if(!r.players.size)rooms.delete(r.code);else io.to(r.code).emit('roomCount',{count:r.players.size})})});
let tick=0;
setInterval(()=>{const dt=.05,now=Date.now();tick++;
 for(const r of rooms.values()){const ps=[...r.players.values()],has=t=>ps.some(p=>p.team===t);
  if(!r.started&&!r.over&&has('blue')&&has('red')){r.started=true;r.left=MATCH}
  if(r.started&&!r.over){r.left-=dt;const full=['blue','red'].find(t=>r.dead[t].size>=TOTAL);
   if(r.left<=0||full){r.over=true;r.left=Math.max(0,r.left);r.resetAt=now+15000;const b=pts(r,'blue'),d=pts(r,'red');r.winner=full?other(full):b>d?'blue':d>b?'red':'draw'}}
  if(r.over&&now>=r.resetAt){r.over=false;r.started=has('blue')&&has('red');r.left=MATCH;r.winner=null;r.dead={blue:new Set(),red:new Set()};r.kills={blue:0,red:0};r.projs=[];
   io.to(r.code).emit('matchReset');for(const p of ps){p.hp=100;p.dead=false;p.kills=p.deaths=0;io.to(r.code).emit('playerRespawned',spawnMsg(p))}}
  for(const p of ps){if(p.dead&&!r.over&&now>=p.deadAt+8000){p.hp=100;p.dead=false;io.to(r.code).emit('playerRespawned',spawnMsg(p))}
   if(p.gun&&!p.dead&&p.state&&!r.over){p.gc-=dt;while(p.gc<=0){p.gc+=.04;const f=fwd(p.state),id=++r.pid,v=[f[0]*1000+p.state.vx,f[1]*1000+p.state.vy,f[2]*1000+p.state.vz],
     b={id,type:'bullet',owner:p.id,team:p.team,x:p.state.x+f[0]*9,y:p.state.y+f[1]*9,z:p.state.z+f[2]*9,v,life:2.2};r.projs.push(b);
     io.to(r.code).emit('projectileSpawn',{id,weapon:'gun',team:p.team,x:b.x,y:b.y,z:b.z,vx:v[0],vy:v[1],vz:v[2]})}}else p.gc=0}
  r.projs=r.projs.filter(m=>{const end=(h)=>{io.to(r.code).emit('projectileEnd',{id:m.id,hit:h,weapon:m.type==='gun'?'gun':'missile',x:m.x,y:m.y,z:m.z});return false};
   const ox=m.x,oy=m.y,oz=m.z;m.life-=dt;
   if(m.type==='missile'){const t=r.players.get(m.tid);if(t&&!t.dead&&t.state){const sp=Math.min(700,Math.hypot(...m.v)+150*dt),cur=norm(m.v),want=norm([t.state.x-m.x,t.state.y-m.y,t.state.z-m.z]);
     m.v=norm(cur.map((c,i)=>c+(want[i]-c)*.22)).map(c=>c*sp)}}
   m.x+=m.v[0]*dt;m.y+=m.v[1]*dt;m.z+=m.v[2]*dt;
   if(m.y<0||m.life<=0)return end(false);
   for(const t of ps){if(t.team===m.team||t.dead||!t.state)continue;
    const d=[m.x-ox,m.y-oy,m.z-oz],w=[t.state.x-ox,t.state.y-oy,t.state.z-oz],l2=d[0]*d[0]+d[1]*d[1]+d[2]*d[2]||1e-6,u=Math.max(0,Math.min(1,(w[0]*d[0]+w[1]*d[1]+w[2]*d[2])/l2)),
     dist=Math.hypot(ox+d[0]*u-t.state.x,oy+d[1]*u-t.state.y,oz+d[2]*u-t.state.z);
    if(dist<(m.type==='missile'?30:14)){hit(r,t,r.players.get(m.owner),m.type==='missile'?70:6,m.type==='gun'?'gun':'missile');return end(true)}}
   if(m.type==='missile')io.to(r.code).emit('projectileUpdate',{id:m.id,x:m.x,y:m.y,z:m.z,vx:m.v[0],vy:m.v[1],vz:m.v[2]});return true});
  if(tick%4===0)io.to(r.code).emit('combatState',{players:ps.map(p=>({id:p.id,name:p.name,team:p.team,hp:p.hp,dead:p.dead,kills:p.kills,deaths:p.deaths,missiles:4,gunAmmo:511}))});
  if(tick%10===0)io.to(r.code).emit('matchState',{left:r.left,started:r.started,over:r.over,winner:r.winner,dead:{blue:[...r.dead.blue],red:[...r.dead.red]},pts:{blue:pts(r,'blue'),red:pts(r,'red')},kills:r.kills})}
},50);
srv.listen(process.env.PORT||3000,()=>console.log('Jet game on http://localhost:'+(process.env.PORT||3000)));
