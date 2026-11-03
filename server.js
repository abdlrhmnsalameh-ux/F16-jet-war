const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true }, maxHttpBufferSize: 1e5 });
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const MAX_PLAYERS = 8;
const TICK_MS = 50;
const RESPAWN_MS = 8000;
const TEAM_SPAWNS = {
  blue: { x: -4300, y: 1.95, z: -8600 + 1120 },
  red:  { x: 5400,  y: 1.95, z: -7000 + 1120 }
};
let projectileSeq = 0;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function safeName(value) {
  return String(value || 'Pilot').replace(/[^a-z0-9 _-]/gi, '').trim().slice(0, 16) || 'Pilot';
}
function roomOf(socket) { return socket.data.room && rooms.get(socket.data.room); }
function spawnFor(team) { return TEAM_SPAWNS[team] || TEAM_SPAWNS.blue; }
function chooseTeam(room) {
  let blue = 0, red = 0;
  for (const p of room.players.values()) p.team === 'red' ? red++ : blue++;
  return blue <= red ? 'blue' : 'red';
}
function roster(room) {
  return [...room.players.entries()].map(([id, p]) => ({
    id, name: p.name, team: p.team, hp: p.hp, kills: p.kills, deaths: p.deaths,
    missiles: p.missiles, gunAmmo: p.gunAmmo, dead: !!p.deadUntil, state: p.state
  }));
}
function broadcastCount(code) {
  const room = rooms.get(code);
  if (room) io.to(code).emit('roomCount', { count: room.players.size });
}
function broadcastCombat(code) {
  const room = rooms.get(code);
  if (room) io.to(code).emit('combatState', { players: roster(room) });
}
function leaveRoom(socket) {
  const code = socket.data.room;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code); socket.data.room = null;
  if (!room) return;
  const player = room.players.get(socket.id);
  room.players.delete(socket.id);
  for (const [id, projectile] of room.projectiles) if (projectile.ownerId === socket.id) room.projectiles.delete(id);
  socket.to(code).emit('playerLeft', { id: socket.id, name: player?.name || 'Pilot' });
  if (!room.players.size) rooms.delete(code);
  else { broadcastCount(code); broadcastCombat(code); }
}
function join(socket, code, name) {
  const room = rooms.get(code);
  if (!room) return socket.emit('roomError', { message: 'Room not found. Check the code.' });
  if (room.players.size >= MAX_PLAYERS) return socket.emit('roomError', { message: 'Room is full (8 pilots maximum).' });
  leaveRoom(socket);
  const team = chooseTeam(room);
  const player = {
    id: socket.id, name: safeName(name), team, state: null,
    hp: 100, kills: 0, deaths: 0, missiles: 4, gunAmmo: 511,
    deadUntil: 0, lastGunAt: 0, lastMissileAt: 0
  };
  room.players.set(socket.id, player);
  socket.data.room = code;
  socket.join(code);
  socket.emit('roomJoined', { code, team, count: room.players.size, players: roster(room) });
  socket.to(code).emit('playerJoined', { id: socket.id, name: player.name, team: player.team });
  broadcastCount(code);
  broadcastCombat(code);
}
function cleanState(input) {
  const out = {};
  const numeric = ['x','y','z','vx','vy','vz','qx','qy','qz','qw','speed','alt','throttle'];
  for (const key of numeric) {
    const value = input?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.max(-1e7, Math.min(1e7, value));
  }
  out.gear = !!input?.gear;
  out.gun = !!input?.gun;
  if (![out.x,out.y,out.z,out.qx,out.qy,out.qz,out.qw].every(Number.isFinite)) return null;
  if (![out.vx,out.vy,out.vz].every(Number.isFinite)) { out.vx = 0; out.vy = 0; out.vz = 0; }
  return out;
}
function forward(state) {
  const x=state.qx, y=state.qy, z=state.qz, w=state.qw;
  return norm({ x: -2*(x*z+w*y), y: -2*(y*z-w*x), z: -(1-2*(x*x+y*y)) });
}
function norm(v) { const l=Math.hypot(v.x,v.y,v.z)||1; return {x:v.x/l,y:v.y/l,z:v.z/l}; }
function add(a,b) { return {x:a.x+b.x,y:a.y+b.y,z:a.z+b.z}; }
function sub(a,b) { return {x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}; }
function mul(a,n) { return {x:a.x*n,y:a.y*n,z:a.z*n}; }
function dist(a,b) { return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z); }
function segmentDistance(a,b,p) {
  const ab=sub(b,a), ap=sub(p,a), den=ab.x*ab.x+ab.y*ab.y+ab.z*ab.z;
  const t=den?Math.max(0,Math.min(1,(ap.x*ab.x+ap.y*ab.y+ap.z*ab.z)/den)):0;
  return dist(add(a,mul(ab,t)),p);
}
function spawnProjectile(room, owner, weapon, targetId=null) {
  if (!owner.state || owner.deadUntil) return null;
  const f=forward(owner.state), s=owner.state;
  const pos=add({x:s.x,y:s.y-0.7,z:s.z},mul(f,weapon==='missile'?7:6));
  const ownV={x:s.vx||0,y:s.vy||0,z:s.vz||0};
  const speed=weapon==='missile'?410:1050;
  const velocity=add(mul(f,speed),ownV);
  const id='p'+(++projectileSeq);
  const projectile={id,weapon,ownerId:owner.id,team:owner.team,targetId,pos,prev:{...pos},velocity,life:weapon==='missile'?18:1.8};
  room.projectiles.set(id,projectile);
  io.to(ownerRoomCode(room)).emit('projectileSpawn',{
    id,weapon,team:owner.team,shooterId:owner.id,x:pos.x,y:pos.y,z:pos.z,
    vx:velocity.x,vy:velocity.y,vz:velocity.z
  });
  return projectile;
}
// Room object lookup is intentionally explicit so projectiles never cross room boundaries.
function ownerRoomCode(room) { for (const [code, value] of rooms) if (value === room) return code; return ''; }
function damagePlayer(room, projectile, target, damage, hitPos) {
  target.hp=Math.max(0,target.hp-damage);
  const killer=room.players.get(projectile.ownerId);
  io.to(ownerRoomCode(room)).emit('combatEvent', {
    type:'hit', weapon:projectile.weapon, shooterId:projectile.ownerId,
    targetId:target.id, damage, x:hitPos.x, y:hitPos.y, z:hitPos.z
  });
  if (target.hp<=0 && !target.deadUntil) {
    target.deadUntil=Date.now()+RESPAWN_MS;
    target.deaths++;
    if (killer && killer.id!==target.id) killer.kills++;
    io.to(ownerRoomCode(room)).emit('combatEvent', {
      type:'shotdown', weapon:projectile.weapon, shooterId:projectile.ownerId,
      targetId:target.id, x:hitPos.x, y:hitPos.y, z:hitPos.z
    });
  }
  broadcastCombat(ownerRoomCode(room));
}
function fireMissile(socket, data) {
  const room=roomOf(socket); if(!room)return;
  const player=room.players.get(socket.id); if(!player||!player.state||player.deadUntil)return;
  const now=Date.now(); if(now-player.lastMissileAt<1800)return;
  if(player.missiles<=0){socket.emit('roomError',{message:'No missiles remaining. Respawn to rearm.'});return;}
  const target=room.players.get(String(data?.targetId||''));
  if(!target||target.team===player.team||target.deadUntil||!target.state)return;
  const origin={x:player.state.x,y:player.state.y,z:player.state.z};
  const targetPos={x:target.state.x,y:target.state.y,z:target.state.z};
  const delta=sub(targetPos,origin),range=Math.hypot(delta.x,delta.y,delta.z),f=forward(player.state);
  const aim=norm(delta),dot=f.x*aim.x+f.y*aim.y+f.z*aim.z;
  if(range>8500||range<120||dot<0.94){socket.emit('roomError',{message:'Missile lock invalid. Keep the enemy in front of you.'});return;}
  player.lastMissileAt=now;player.missiles--;
  spawnProjectile(room,player,'missile',target.id);
  broadcastCombat(socket.data.room);
}
function crashPlayer(socket) {
  const room=roomOf(socket); if(!room)return;
  const p=room.players.get(socket.id); if(!p||p.deadUntil)return;
  p.hp=0;p.deadUntil=Date.now()+RESPAWN_MS;p.deaths++;
  io.to(socket.data.room).emit('combatEvent',{type:'crash',targetId:p.id,x:p.state?.x||0,y:p.state?.y||0,z:p.state?.z||0});
  broadcastCombat(socket.data.room);
}

io.on('connection', socket => {
  socket.on('createRoom', data => {
    leaveRoom(socket);
    const code=makeCode();
    rooms.set(code,{players:new Map(),projectiles:new Map(),lastCombatAt:0});
    join(socket,code,data?.name);
  });
  socket.on('joinRoom', data => {
    const code=String(data?.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5);
    if(!code)return socket.emit('roomError',{message:'Enter a valid room code.'});
    join(socket,code,data?.name);
  });
  socket.on('playerState', input => {
    const room=roomOf(socket);if(!room)return;
    const player=room.players.get(socket.id);if(!player||player.deadUntil)return;
    const state=cleanState(input);if(!state)return;
    player.state=state;
    socket.to(socket.data.room).volatile.emit('playerState',{
      id:socket.id,name:player.name,team:player.team,
      state:{...state,hp:player.hp,dead:false}
    });
  });
  socket.on('fireWeapon', data => { if(data?.weapon==='missile')fireMissile(socket,data); });
  socket.on('crashRequest', () => crashPlayer(socket));
  socket.on('respawnRequest', () => { /* respawn is server-timed; request is intentionally not trusted */ });
  socket.on('disconnect', () => leaveRoom(socket));
});

setInterval(() => {
  const now=Date.now(),dt=TICK_MS/1000;
  for(const [code,room] of rooms){
    // Refresh scoreboard and remaining ammunition without flooding the room.
    if(now-(room.lastCombatAt||0)>750){room.lastCombatAt=now;broadcastCombat(code)}
    // Server-controlled cannon cadence and ammunition.
    for(const p of room.players.values()){
      if(p.state && !p.deadUntil && p.state.gun && now-p.lastGunAt>=80 && p.gunAmmo>0){
        p.lastGunAt=now;p.gunAmmo--;
        spawnProjectile(room,p,'gun');
      }
      if(p.deadUntil && now>=p.deadUntil){
        p.deadUntil=0;p.hp=100;p.missiles=4;p.gunAmmo=511;p.state=null;
        const sp=spawnFor(p.team);
        io.to(code).emit('playerRespawned',{id:p.id,name:p.name,team:p.team,...sp});
        broadcastCombat(code);
      }
    }
    for(const [id,shot] of room.projectiles){
      shot.prev={...shot.pos};shot.life-=dt;
      if(shot.weapon==='missile'){
        const target=room.players.get(shot.targetId);
        if(!target||!target.state||target.deadUntil){shot.life=0;}
        else {
          const targetPos={x:target.state.x+(target.state.vx||0)*.18,y:target.state.y+(target.state.vy||0)*.18,z:target.state.z+(target.state.vz||0)*.18};
          const desired=norm(sub(targetPos,shot.pos)),current=norm(shot.velocity);
          const dir=norm(add(mul(current,1-Math.min(1,2.1*dt)),mul(desired,Math.min(1,2.1*dt))));
          const speed=Math.min(620,Math.hypot(shot.velocity.x,shot.velocity.y,shot.velocity.z)+32*dt);
          shot.velocity=mul(dir,speed);
        }
      }
      shot.pos=add(shot.pos,mul(shot.velocity,dt));
      let hit=null;
      for(const target of room.players.values()){
        if(target.id===shot.ownerId||target.team===shot.team||target.deadUntil||!target.state)continue;
        const tp={x:target.state.x,y:target.state.y,z:target.state.z};
        const radius=shot.weapon==='missile'?24:13;
        if(segmentDistance(shot.prev,shot.pos,tp)<radius){hit=target;break;}
      }
      if(hit){damagePlayer(room,shot,hit,shot.weapon==='missile'?78:12,shot.pos);shot.life=0;}
      if(shot.life<=0){io.to(code).emit('projectileEnd',{id:shot.id,hit:!!hit,x:shot.pos.x,y:shot.pos.y,z:shot.pos.z,weapon:shot.weapon});room.projectiles.delete(id);}
      else io.to(code).volatile.emit('projectileUpdate',{id:shot.id,x:shot.pos.x,y:shot.pos.y,z:shot.pos.z,vx:shot.velocity.x,vy:shot.velocity.y,vz:shot.velocity.z});
    }
  }
},TICK_MS);

server.listen(PORT,'0.0.0.0',()=>console.log(`F-16 Island Warfare PvP server listening on port ${PORT}`));
