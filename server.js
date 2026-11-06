// Run: npm i express socket.io
// Then: node server.js
// index.html must sit next to this file.

const express=require('express'),http=require('http'),{Server}=require('socket.io');
const app=express(),srv=http.createServer(app),io=new Server(srv,{cors:{origin:'*'},perMessageDeflate:false,maxHttpBufferSize:1e6});
const path=require('path'),fs=require('fs'),roots=[__dirname,path.join(__dirname,'public')];
roots.forEach(r=>app.use(express.static(r)));
app.get('/',(q,s)=>{const f=roots.flatMap(r=>['index.html','index-2.html'].map(n=>path.join(r,n))).find(fs.existsSync);f?s.sendFile(f):s.status(404).send('index.html not found next to server.js')});
const BASE={blue:-3600,red:3600},MATCH=600,TOTAL=36,PT_BLD=10,PT_KILL=100,rooms=new Map();
app.get('/debug',(q,s)=>{const ls=d=>fs.existsSync(d)?fs.readdirSync(d):null;s.json({version:'v5-warthunder-combat',dir:__dirname,files:ls(__dirname),public:ls(path.join(__dirname,'public'))})});
const fin=(...a)=>a.every(Number.isFinite),other=t=>t==='blue'?'red':'blue';
const norm=v=>{const l=Math.hypot(...v)||1;return v.map(x=>x/l)};
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const add=(a,b)=>a.map((x,i)=>x+b[i]);
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const mul=(a,k)=>a.map(x=>x*k);
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
const statePos=s=>[s.x,s.y,s.z],stateVel=s=>[s.vx||0,s.vy||0,s.vz||0];
const rot=(q,[x,y,z])=>{const ix=q.qw*x+q.qy*z-q.qz*y,iy=q.qw*y+q.qz*x-q.qx*z,iz=q.qw*z+q.qx*y-q.qy*x,iw=-q.qx*x-q.qy*y-q.qz*z;return[ix*q.qw+iw*-q.qx+iy*-q.qz-iz*-q.qy,iy*q.qw+iw*-q.qy+iz*-q.qx-ix*-q.qz,iz*q.qw+iw*-q.qz+ix*-q.qy-iy*-q.qx]};
const fwd=s=>fin(s.fx,s.fy,s.fz)?norm([s.fx,s.fy,s.fz]):norm(rot(s,[0,0,-1]));
const pts=(r,t)=>r.dead[other(t)].size*PT_BLD+r.kills[t]*PT_KILL;

function newRoom(){
 let c;
 do c=Math.random().toString(36).slice(2,8).toUpperCase();
 while(rooms.has(c));
 const r={code:c,players:new Map(),projs:[],decoys:[],pid:0,left:MATCH,started:false,over:false,winner:null,resetAt:0,dead:{blue:new Set(),red:new Set()},kills:{blue:0,red:0}};
 rooms.set(c,r);
 return r;
}

const roster=r=>[...r.players.values()].map(p=>({id:p.id,name:p.name,team:p.team,state:p.state}));

function spawnMsg(p){
 return{id:p.id,name:p.name,team:p.team,x:BASE[p.team],y:1.95,z:1120,spawnSeq:p.spawnSeq,invulnerableUntil:p.invulnerableUntil};
}

function join(sock,r,name){
 if(r.players.size>=8)return sock.emit('roomError',{message:'Room is full'});
 const n=t=>[...r.players.values()].filter(p=>p.team===t).length;
 const team=n('blue')<=n('red')?'blue':'red';
 const now=Date.now();
 const p={id:sock.id,name:String(name||'Pilot').slice(0,16),team,state:null,hp:100,dead:false,deadAt:0,respawnAt:0,spawnSeq:0,invulnerableUntil:now+10000,kills:0,deaths:0,gun:false,gc:0,mc:0,missileShots:0,missileStation:0,missileReloadUntil:0,lockedTarget:null,lockSnapshot:null,flareAt:0,gunTraceCounter:0};
 r.players.set(sock.id,p);
 sock.join(r.code);
 sock.data.room=r.code;
 sock.emit(r.players.size===1?'roomCreated':'roomJoined',{code:r.code,team,count:r.players.size,players:roster(r)});
 sock.to(r.code).emit('playerJoined',{id:p.id,name:p.name,team});
 io.to(r.code).emit('roomCount',{count:r.players.size});
}

function clearPlayerLock(r,p){
 if(!p.lockedTarget)return;
 const old=r.players.get(p.lockedTarget);
 if(old)io.to(old.id).emit('missileWarning',{locked:false,shooterId:p.id});
 p.lockedTarget=null;
 p.lockSnapshot=null;
}

function killPlayer(r,p,owner,weapon){
 if(!p||p.dead)return false;
 p.hp=0;p.dead=true;p.deadAt=Date.now();p.respawnAt=p.deadAt+8000;p.deaths++;
 clearPlayerLock(r,p);
 for(const attacker of r.players.values())if(attacker.lockedTarget===p.id)clearPlayerLock(r,attacker);
 if(owner&&owner.id!==p.id&&owner.team!==p.team){owner.kills++;r.kills[owner.team]++}
 io.to(r.code).emit('combatEvent',{targetId:p.id,shooterId:owner?.id,weapon,dead:true});
 return true;
}

function hit(r,t,owner,dmg,weapon,now){
 if(t.dead)return false;
 if(t.invulnerableUntil>now){
  io.to(t.id).emit('combatEvent',{targetId:t.id,shooterId:owner?.id,weapon:'shield',blocked:true});
  return false;
 }
 t.hp=Math.max(0,t.hp-dmg);
 if(t.hp<=0)killPlayer(r,t,owner,weapon);
 else io.to(r.code).emit('combatEvent',{targetId:t.id,shooterId:owner?.id,weapon});
 return true;
}

function respawnPlayer(r,p){
 if(!p||!p.dead)return false;
 p.dead=false;p.hp=100;p.deadAt=0;p.respawnAt=0;p.spawnSeq++;p.invulnerableUntil=Date.now()+10000;
 p.state={x:BASE[p.team],y:1.95,z:1120,vx:0,vy:0,vz:0,qx:0,qy:0,qz:0,qw:1,fx:0,fy:0,fz:-1};
 p.gun=false;p.gc=0;p.missileStation=0;p.lockedTarget=null;p.lockSnapshot=null;
 io.to(r.code).emit('playerRespawned',spawnMsg(p));
 return true;
}

// SERVER-AUTHORITATIVE MISSILE GUIDANCE
function missileGuidance(r,m,dt,now){
 const p=r.players.get(m.tid);
 if(!p||p.dead||!p.state)return false;
 const targetPos=statePos(p.state),targetVel=stateVel(p.state),missilePos=[m.x,m.y,m.z];
 const missileSpeed=Math.max(1,Math.hypot(...m.v)),missileDir=norm(m.v);
 const targetRange=dist(missilePos,targetPos);
 let decoy=null;

 if(m.decoyUntil>now)decoy=r.decoys.find(f=>f.id===m.decoyId&&f.life>0)||null;

 if(!decoy){
  m.decoyId=null;m.decoyUntil=0;
  const aircraftLOS=norm(sub(targetPos,missilePos));
  const aircraftAngle=Math.acos(Math.max(-1,Math.min(1,dot(missileDir,aircraftLOS))));
  const aircraftScore=Math.max(0,1-aircraftAngle/1.35)/(1+targetRange/900);
  let bestScore=0;

  for(const f of r.decoys){
   if(f.life<=0||f.team!==p.team)continue;
   const fp=[f.x,f.y,f.z],to=sub(fp,missilePos),range=Math.hypot(...to);
   if(range>480||range<8||range>targetRange*1.12)continue;
   const angle=Math.acos(Math.max(-1,Math.min(1,dot(missileDir,norm(to)))));
   if(angle>0.95)continue;
   const freshness=Math.min(1,f.life/2.4);
   const score=(1-angle/0.95)*freshness*1.45/(1+range/500);
   if(score>bestScore){bestScore=score;decoy=f}
  }

  if(decoy&&bestScore>aircraftScore+0.12){m.decoyId=decoy.id;m.decoyUntil=now+900}
  else decoy=null;
 }

 const aim=decoy?[decoy.x,decoy.y,decoy.z]:add(targetPos,mul(targetVel,Math.min(1.35,targetRange/Math.max(220,missileSpeed))));
 const toAim=sub(aim,missilePos),want=norm(toAim);
 const angle=Math.acos(Math.max(-1,Math.min(1,dot(missileDir,want))));
 const maxLat=112,turnRate=Math.min(0.24,maxLat/missileSpeed),maxAngle=turnRate*dt;
 let newDir=missileDir;

 if(angle>1e-5){
  const axis=cross(missileDir,want),axisLen=Math.hypot(...axis);
  if(axisLen>1e-6){
   const a=Math.min(angle,maxAngle),u=mul(axis,1/axisLen),c=Math.cos(a),sn=Math.sin(a);
   newDir=norm(add(add(mul(missileDir,c),mul(cross(u,missileDir),sn)),mul(u,dot(u,missileDir)*(1-c))));
  }
 }

 const thrust=m.age<2.0?105:(m.age<4.6?18:0),drag=0.000038*missileSpeed*missileSpeed;
 const speed=Math.max(155,Math.min(690,missileSpeed+(thrust-drag)*dt));
 m.v=mul(newDir,speed);m.v[1]-=9.81*dt;
 m.seekingDecoy=!!decoy;
 return true;
}

function missileThreats(r,now){
 const byTarget=new Map();
 for(const m of r.projs){
  if(m.type!=='missile')continue;
  const p=r.players.get(m.tid);
  if(!p||p.dead||!p.state)continue;
  const rel=sub([m.x,m.y,m.z],statePos(p.state)),distance=Math.hypot(...rel),relVel=sub(m.v,stateVel(p.state));
  const closing=distance>1?-dot(rel,relVel)/distance:0,forward=fwd(p.state),right=norm(cross(forward,[0,1,0]));
  const bearing=Math.atan2(dot(rel,right),dot(rel,forward))*180/Math.PI;
  const item={id:m.id,distance,bearing,closing,decoy:!!m.seekingDecoy};
  const a=byTarget.get(p.id)||[];
  a.push(item);byTarget.set(p.id,a);
 }
 for(const p of r.players.values()){
  if(p.dead)continue;
  const threats=(byTarget.get(p.id)||[]).sort((a,b)=>a.distance-b.distance).slice(0,3);
  io.to(p.id).emit('missileThreat',{threats,serverTime:now});
 }
}

io.on('connection',sock=>{
 const R=()=>rooms.get(sock.data.room),P=()=>R()?.players.get(sock.id);

 sock.on('createRoom',d=>join(sock,newRoom(),d?.name));
 sock.on('joinRoom',d=>{
  const r=rooms.get(String(d?.code||'').toUpperCase());
  r?join(sock,r,d.name):sock.emit('roomError',{message:'Room not found'});
 });

 sock.on('playerState',d=>{
  const p=P();
  if(!p||p.dead||!d||!fin(d.x,d.y,d.z,d.qx,d.qy,d.qz,d.qw))return;
  p.state={x:d.x,y:d.y,z:d.z,vx:Number.isFinite(d.vx)?d.vx:0,vy:Number.isFinite(d.vy)?d.vy:0,vz:Number.isFinite(d.vz)?d.vz:0,qx:d.qx,qy:d.qy,qz:d.qz,qw:d.qw,fx:d.fx,fy:d.fy,fz:d.fz};
  p.gun=!!d.gun;
  sock.volatile.to(sock.data.room).emit('playerState',{id:p.id,name:p.name,team:p.team,state:{...p.state,hp:p.hp,dead:p.dead,invulnerable:p.invulnerableUntil>Date.now()}});
 });

 sock.on('lockState',d=>{
  const r=R(),p=P();
  if(!r||!p||p.dead)return;
  const id=typeof d?.targetId==='string'?d.targetId:null,t=id?r.players.get(id):null;
  const valid=t&&!t.dead&&t.team!==p.team&&t.state&&p.state,next=valid?id:null;
  if(p.lockedTarget!==next){
   clearPlayerLock(r,p);
   if(next){
    p.lockedTarget=next;p.lockSnapshot={...t.state};
    io.to(t.id).emit('missileWarning',{locked:true,shooterId:p.id,shooterName:p.name});
   }
  }
 });

 sock.on('flareDeploy',()=>{
  const r=R(),p=P(),now=Date.now();
  if(!r||!p||p.dead||!p.state||now-p.flareAt<1200)return;
  p.flareAt=now;
  const fwdv=fwd(p.state),right=norm(cross(fwdv,[0,1,0]));
  for(let i=0;i<3;i++){
   const side=(i-1)*2.2,back=(i-1)*3.5;
   const pos=[p.state.x-fwdv[0]*back+right[0]*side,p.state.y-fwdv[1]*back+right[1]*side,p.state.z-fwdv[2]*back+right[2]*side];
   const f={id:++r.pid,owner:p.id,team:p.team,x:pos[0],y:pos[1],z:pos[2],vx:p.state.vx-right[0]*side*0.7,vy:p.state.vy-7.5-i*1.4,vz:p.state.vz-right[2]*side*0.7,life:3.6-i*0.18};
   r.decoys.push(f);
   io.to(r.code).emit('flareSpawn',f);
  }
 });

 // MISSILE FIRING — maximum range is 2,000 metres.
 sock.on('fireWeapon',d=>{
  const r=R(),p=P(),now=Date.now();
  const reject=reason=>sock.emit('weaponResult',{weapon:'missile',ok:false,reason});
  if(!r||!p||p.dead||!p.state||d?.weapon!=='missile')return reject('Aircraft unavailable');
  if(now-p.mc<2200)return reject('Missile launcher reloading');
  if(now<p.missileReloadUntil)return reject('Missiles reloading');

  const t=r.players.get(d.targetId);
  if(!t||t.dead||t.team===p.team||!t.state)return reject('No valid enemy target');

  const delta=sub(statePos(t.state),statePos(p.state)),range=Math.hypot(...delta),forward=fwd(p.state);

  if(range>2000||range<100)return reject('Target outside missile range (2 km)');
  if(dot(forward,norm(delta))<Math.cos(0.8))return reject('Target outside launch cone');

  p.mc=now;p.missileShots++;
  if(p.missileShots>=2){p.missileShots=0;p.missileReloadUntil=now+5000}

  const id=++r.pid,v=add(mul(forward,265),stateVel(p.state));
  const pylons=[[5.1,-.12,3.7],[-5.1,-.12,3.7],[2.7,-.62,.8],[-2.7,-.62,.8]];
  const pylon=pylons[p.missileStation++%pylons.length];
  const launchOffset=rot(p.state,pylon),launchPos=add(statePos(p.state),launchOffset);

  const m={id,type:'missile',owner:p.id,team:p.team,tid:t.id,x:launchPos[0],y:launchPos[1],z:launchPos[2],v,life:9,age:0,travelled:0,maxRange:2000,decoyId:null,decoyUntil:0};
  r.projs.push(m);

  sock.emit('weaponResult',{weapon:'missile',ok:true,id,targetId:t.id});
  io.to(r.code).emit('projectileSpawn',{id,weapon:'missile',owner:p.id,team:p.team,targetId:t.id,x:m.x,y:m.y,z:m.z,vx:m.v[0],vy:m.v[1],vz:m.v[2],serverTime:now});
  io.to(t.id).emit('missileIncoming',{id,shooterId:p.id,shooterName:p.name});
 });

 sock.on('crashRequest',()=>{const r=R(),p=P();if(r&&p)killPlayer(r,p,null,'crash')});
 sock.on('respawnRequest',()=>{});

 sock.on('cityDestroyed',d=>{
  const r=R(),p=P();
  if(!r||!p||p.dead||r.over||!r.started||!['blue','red'].includes(d?.team)||d.team===p.team||!Number.isInteger(d.cid)||d.cid<0||d.cid>=TOTAL||r.dead[d.team].has(d.cid))return;
  r.dead[d.team].add(d.cid);
  sock.to(r.code).emit('cityDestroyed',{team:d.team,cid:d.cid});
 });

 sock.on('disconnect',()=>{
  const r=R(),p=P();
  if(!r||!p)return;
  clearPlayerLock(r,p);
  for(const attacker of r.players.values())if(attacker.lockedTarget===p.id)clearPlayerLock(r,attacker);
  r.players.delete(sock.id);
  io.to(r.code).emit('playerLeft',{id:sock.id,name:p.name});
  if(!r.players.size)rooms.delete(r.code);
  else io.to(r.code).emit('roomCount',{count:r.players.size});
 });
});

let tick=0;

setInterval(()=>{
 const dt=.05,now=Date.now();
 tick++;

 for(const r of rooms.values()){
  for(const f of r.decoys){
   f.life-=dt;f.x+=f.vx*dt;f.y+=f.vy*dt;f.z+=f.vz*dt;f.vy-=9.81*dt;
  }
  r.decoys=r.decoys.filter(f=>f.life>0);

  const ps=[...r.players.values()],has=t=>ps.some(p=>p.team===t);
  if(!r.started&&!r.over&&has('blue')&&has('red')){r.started=true;r.left=MATCH}

  if(r.started&&!r.over){
   r.left-=dt;
   const full=['blue','red'].find(t=>r.dead[t].size>=TOTAL);
   if(r.left<=0||full){
    r.over=true;r.left=Math.max(0,r.left);r.resetAt=now+15000;
    const b=pts(r,'blue'),d=pts(r,'red');
    r.winner=full?other(full):b>d?'blue':d>b?'red':'draw';
   }
  }

  if(r.over&&now>=r.resetAt){
   r.over=false;r.started=has('blue')&&has('red');r.left=MATCH;r.winner=null;
   r.dead={blue:new Set(),red:new Set()};r.kills={blue:0,red:0};r.projs=[];r.decoys=[];
   io.to(r.code).emit('matchReset');
   for(const p of ps){p.kills=0;p.deaths=0;p.hp=0;p.dead=true;respawnPlayer(r,p)}
  }

  const gunTracers=[];
  for(const p of ps){
   if(p.dead&&p.respawnAt&&now>=p.respawnAt&&!r.over)respawnPlayer(r,p);
   if(p.gun&&!p.dead&&p.state&&!r.over){
    p.gc-=dt;
    while(p.gc<=0){
     p.gc+=.01;
     const f=fwd(p.state),id=++r.pid,v=add(mul(f,1030),stateVel(p.state));
     const muzzle=add(statePos(p.state),rot(p.state,[-.55,-.1,-6.3]));
     const b={id,type:'bullet',owner:p.id,team:p.team,x:muzzle[0],y:muzzle[1],z:muzzle[2],v,life:1.8};
     r.projs.push(b);
     if((p.gunTraceCounter++%2)===0)gunTracers.push({x:b.x,y:b.y,z:b.z,vx:v[0],vy:v[1],vz:v[2],team:p.team,owner:p.id});
    }
   }else p.gc=0;
  }

  if(gunTracers.length)io.to(r.code).emit('gunTracerBatch',gunTracers);

  r.projs=r.projs.filter(m=>{
   const end=hit=>{
    if(m.type==='missile')io.to(r.code).emit('projectileEnd',{id:m.id,hit,weapon:'missile',x:m.x,y:m.y,z:m.z});
    return false;
   };

   const ox=m.x,oy=m.y,oz=m.z;
   m.life-=dt;
   if(m.type==='missile'){m.age+=dt;if(!missileGuidance(r,m,dt,now))return end(false)}
   else if(m.type==='bullet'){m.v[1]-=9.81*dt}

   m.x+=m.v[0]*dt;m.y+=m.v[1]*dt;m.z+=m.v[2]*dt;

   if(m.type==='missile'){
    m.travelled+=Math.hypot(m.x-ox,m.y-oy,m.z-oz);
    if(m.travelled>=m.maxRange||m.life<=0||m.y<0)return end(false);
    if(m.decoyId){
     const f=r.decoys.find(x=>x.id===m.decoyId);
     if(f&&dist([m.x,m.y,m.z],[f.x,f.y,f.z])<12)return end(false);
    }
   }else if(m.life<=0||m.y<0)return end(false);

   for(const t of ps){
    if(t.team===m.team||t.dead||!t.state)continue;
    const a=[ox,oy,oz],b=[m.x,m.y,m.z],seg=sub(b,a),to=sub(statePos(t.state),a),l2=dot(seg,seg)||1e-6;
    const u=Math.max(0,Math.min(1,dot(to,seg)/l2)),closest=add(a,mul(seg,u)),d=dist(closest,statePos(t.state));
    if(d<(m.type==='missile'?28:12)){
     hit(r,t,r.players.get(m.owner),m.type==='missile'?100:2.5,m.type==='missile'?'missile':'gun',now);
     return end(true);
    }
   }

   if(m.type==='missile')io.to(r.code).emit('projectileUpdate',{id:m.id,x:m.x,y:m.y,z:m.z,vx:m.v[0],vy:m.v[1],vz:m.v[2],serverTime:now});
   return true;
  });

  if(tick%2===0)missileThreats(r,now);

  if(tick%4===0)io.to(r.code).emit('combatState',{players:ps.map(p=>({id:p.id,name:p.name,team:p.team,hp:p.hp,dead:p.dead,kills:p.kills,deaths:p.deaths,missiles:4,gunAmmo:-1,spawnSeq:p.spawnSeq,invulnerable:p.invulnerableUntil>now,invulnerabilityMs:Math.max(0,p.invulnerableUntil-now)}))});

  if(tick%10===0)io.to(r.code).emit('matchState',{left:r.left,started:r.started,over:r.over,winner:r.winner,dead:{blue:[...r.dead.blue],red:[...r.dead.red]},pts:{blue:pts(r,'blue'),red:pts(r,'red')},kills:r.kills});
 }
},50);

srv.listen(process.env.PORT||3000,()=>console.log('Jet game on http://localhost:'+(process.env.PORT||3000)));
