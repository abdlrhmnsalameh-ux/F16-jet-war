// Run: npm i express socket.io
// Then: node server.js
// index.html must sit next to this file.

const express = require('express'),
  http = require('http'),
  { Server } = require('socket.io');

const app = express(),
  srv = http.createServer(app),
  io = new Server(srv, { cors: { origin: '*' } });

const path = require('path'),
  fs = require('fs'),
  roots = [__dirname, path.join(__dirname, 'public')];

roots.forEach(r => app.use(express.static(r)));

app.get('/', (q, s) => {
  const f = roots.flatMap(r =>
    ['index.html', 'index-2.html'].map(n => path.join(r, n))
  ).find(fs.existsSync);

  f ? s.sendFile(f) : s.status(404).send('index.html not found next to server.js');
});

const BASE = { blue: -3600, red: 3600 };
const MATCH = 600;
const TOTAL = 36;
const PT_BLD = 10;
const PT_KILL = 100;
const rooms = new Map();

app.get('/debug', (q, s) => {
  const ls = d => fs.existsSync(d) ? fs.readdirSync(d) : null;
  s.json({
    version: 'v3-debug',
    dir: __dirname,
    files: ls(__dirname),
    public: ls(path.join(__dirname, 'public'))
  });
});

const fin = (...a) => a.every(Number.isFinite);
const other = t => t === 'blue' ? 'red' : 'blue';

const norm = v => {
  const l = Math.hypot(...v) || 1;
  return v.map(x => x / l);
};

// Nose points toward -Z in the client.
const rot = (q, [x, y, z]) => {
  const ix = q.qw * x + q.qy * z - q.qz * y;
  const iy = q.qw * y + q.qz * x - q.qx * z;
  const iz = q.qw * z + q.qx * y - q.qy * x;
  const iw = -q.qx * x - q.qy * y - q.qz * z;

  return [
    ix * q.qw + iw * -q.qx + iy * -q.qz - iz * -q.qy,
    iy * q.qw + iw * -q.qy + iz * -q.qx - ix * -q.qz,
    iz * q.qw + iw * -q.qz + ix * -q.qy - iy * -q.qx
  ];
};

const fwd = s =>
  fin(s.fx, s.fy, s.fz)
    ? norm([s.fx, s.fy, s.fz])
    : norm(rot(s, [0, 0, -1]));

const pts = (r, t) =>
  r.dead[other(t)].size * PT_BLD + r.kills[t] * PT_KILL;

function newRoom() {
  let c;

  do {
    c = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (rooms.has(c));

  const r = {
    code: c,
    players: new Map(),
    projs: [],
    decoys: [],
    pid: 0,
    left: MATCH,
    started: false,
    over: false,
    winner: null,
    resetAt: 0,
    dead: { blue: new Set(), red: new Set() },
    kills: { blue: 0, red: 0 }
  };

  rooms.set(c, r);
  return r;
}

const roster = r =>
  [...r.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    team: p.team,
    state: p.state
  }));

function join(sock, r, name) {
  if (r.players.size >= 8) {
    return sock.emit('roomError', { message: 'Room is full' });
  }

  const n = t => [...r.players.values()].filter(p => p.team === t).length;
  const team = n('blue') <= n('red') ? 'blue' : 'red';

  const p = {
    id: sock.id,
    name: String(name || 'Pilot').slice(0, 16),
    team,
    state: null,
    hp: 100,
    dead: false,
    deadAt: 0,
    kills: 0,
    deaths: 0,
    gun: false,
    gc: 0,

    // Missile cooldown system
    mc: 0,
    missileShots: 0,
    missileReloadUntil: 0,

    lockedTarget: null,
    lockSnapshot: null,
    flareAt: 0
  };

  r.players.set(sock.id, p);
  sock.join(r.code);
  sock.data.room = r.code;

  sock.emit(
    r.players.size === 1 ? 'roomCreated' : 'roomJoined',
    {
      code: r.code,
      team,
      count: r.players.size,
      players: roster(r)
    }
  );

  sock.to(r.code).emit('playerJoined', {
    id: p.id,
    name: p.name,
    team
  });

  io.to(r.code).emit('roomCount', {
    count: r.players.size
  });
}

const spawnMsg = p => ({
  id: p.id,
  name: p.name,
  team: p.team,
  x: BASE[p.team],
  y: 1.95,
  z: 1120
});

function hit(r, t, owner, dmg, weapon) {
  if (t.dead) return;

  t.hp -= dmg;

  io.to(r.code).emit('combatEvent', {
    targetId: t.id,
    shooterId: owner?.id,
    weapon
  });

  if (t.hp <= 0) {
    t.hp = 0;
    t.dead = true;
    t.deadAt = Date.now();
    t.deaths++;

    if (owner && owner.team !== t.team) {
      owner.kills++;
      r.kills[owner.team]++;
    }
  }
}

io.on('connection', sock => {
  const R = () => rooms.get(sock.data.room);
  const P = () => R()?.players.get(sock.id);

  sock.on('createRoom', d => join(sock, newRoom(), d?.name));

  sock.on('joinRoom', d => {
    const r = rooms.get(String(d?.code || '').toUpperCase());

    r
      ? join(sock, r, d.name)
      : sock.emit('roomError', { message: 'Room not found' });
  });

  // Player position and orientation.
  sock.on('playerState', d => {
    const p = P();

    if (!p || !d ||
      !fin(d.x, d.y, d.z, d.qx, d.qy, d.qz, d.qw)) return;

    p.state = {
      x: d.x,
      y: d.y,
      z: d.z,
      vx: +d.vx || 0,
      vy: +d.vy || 0,
      vz: +d.vz || 0,
      qx: d.qx,
      qy: d.qy,
      qz: d.qz,
      qw: d.qw,
      fx: d.fx,
      fy: d.fy,
      fz: d.fz
    };

    p.gun = !!d.gun;

    sock.to(sock.data.room).emit('playerState', {
      id: p.id,
      name: p.name,
      team: p.team,
      state: { ...p.state, hp: p.hp, dead: p.dead }
    });
  });

  // Radar lock warning.
  sock.on('lockState', d => {
    const r = R();
    const p = P();

    if (!r || !p || p.dead) return;

    const id = typeof d?.targetId === 'string' ? d.targetId : null;
    const t = id ? r.players.get(id) : null;

    const valid =
      t && !t.dead && t.team !== p.team && t.state && p.state;

    const next = valid ? id : null;

    if (p.lockedTarget !== next) {
      if (p.lockedTarget) {
        const old = r.players.get(p.lockedTarget);

        if (old) {
          io.to(old.id).emit('missileWarning', {
            locked: false,
            shooterId: p.id
          });
        }
      }

      p.lockedTarget = next;

      p.lockSnapshot = next
        ? {
            x: t.state.x,
            y: t.state.y,
            z: t.state.z,
            vx: t.state.vx,
            vy: t.state.vy,
            vz: t.state.vz
          }
        : null;

      if (t) {
        io.to(t.id).emit('missileWarning', {
          locked: true,
          shooterId: p.id,
          shooterName: p.name
        });
      }
    }
  });

  // Server-side flare deployment.
  sock.on('flareDeploy', () => {
    const r = R();
    const p = P();
    const now = Date.now();

    if (!r || !p || p.dead || !p.state || now - p.flareAt < 900) return;

    p.flareAt = now;

    const f = {
      id: ++r.pid,
      owner: p.id,
      team: p.team,
      x: p.state.x,
      y: p.state.y,
      z: p.state.z,
      vx: p.state.vx,
      vy: p.state.vy - 8,
      vz: p.state.vz,
      life: 3.5
    };

    r.decoys.push(f);
    io.to(r.code).emit('flareSpawn', f);
  });

  // Missile firing and cooldown.
  sock.on('fireWeapon', d => {
    const r = R();
    const p = P();
    const now = Date.now();

    if (
      !r ||
      !p ||
      p.dead ||
      !p.state ||
      d?.weapon !== 'missile' ||
      now - p.mc < 2000 ||
      now < p.missileReloadUntil
    ) return;

    const t = r.players.get(d.targetId);

    if (
      !t ||
      t.dead ||
      t.team === p.team ||
      !t.state ||
      p.lockedTarget !== t.id
    ) return;

    // Record this missile shot.
    p.mc = now;
    p.missileShots++;

    // After every two shots, impose a five-second reload.
    if (p.missileShots >= 2) {
      p.missileShots = 0;
      p.missileReloadUntil = now + 5000;
    }

    const f = fwd(p.state);
    const id = ++r.pid;

    const m = {
      id,
      type: 'missile',
      owner: p.id,
      team: p.team,
      tid: t.id,

      x: p.state.x + f[0] * 9,
      y: p.state.y + f[1] * 9,
      z: p.state.z + f[2] * 9,

      v: [
        f[0] * 245 + p.state.vx,
        f[1] * 245 + p.state.vy,
        f[2] * 245 + p.state.vz
      ],

      life: 16,
      age: 0,

      // Maximum missile travel distance.
      travelled: 0,
      maxRange: 2000,

      launchX: p.state.x,
      launchY: p.state.y,
      launchZ: p.state.z,

      initialTarget: p.lockSnapshot || {
        x: t.state.x,
        y: t.state.y,
        z: t.state.z,
        vx: t.state.vx,
        vy: t.state.vy,
        vz: t.state.vz
      },

      seeker: true
    };

    r.projs.push(m);

    io.to(r.code).emit('projectileSpawn', {
      id,
      weapon: 'missile',
      team: p.team,
      x: m.x,
      y: m.y,
      z: m.z,
      vx: m.v[0],
      vy: m.v[1],
      vz: m.v[2]
    });

    io.to(t.id).emit('missileIncoming', {
      id,
      shooterId: p.id,
      shooterName: p.name
    });
  });

  sock.on('crashRequest', () => {
    const r = R();
    const p = P();

    if (r && p && !p.dead) {
      p.hp = 0;
      p.dead = true;
      p.deadAt = Date.now();
      p.deaths++;
    }
  });

  sock.on('respawnRequest', () => {});

  sock.on('cityDestroyed', d => {
    const r = R();
    const p = P();

    if (
      !r ||
      !p ||
      r.over ||
      !r.started ||
      !['blue', 'red'].includes(d?.team) ||
      d.team === p.team ||
      !Number.isInteger(d.cid) ||
      d.cid < 0 ||
      d.cid >= TOTAL ||
      r.dead[d.team].has(d.cid)
    ) return;

    r.dead[d.team].add(d.cid);

    sock.to(r.code).emit('cityDestroyed', {
      team: d.team,
      cid: d.cid
    });
  });

  sock.on('disconnect', () => {
    const r = R();
    const p = P();

    if (!r || !p) return;

    r.players.delete(sock.id);

    io.to(r.code).emit('playerLeft', {
      id: sock.id,
      name: p.name
    });

    if (!r.players.size) {
      rooms.delete(r.code);
    } else {
      io.to(r.code).emit('roomCount', {
        count: r.players.size
      });
    }
  });
});

// Main game simulation.
let tick = 0;

setInterval(() => {
  const dt = 0.05;
  const now = Date.now();

  tick++;

  for (const r of rooms.values()) {

    // Update flares.
    for (const f of r.decoys) {
      f.life -= dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.z += f.vz * dt;
      f.vy -= 5 * dt;
    }

    r.decoys = r.decoys.filter(f => f.life > 0);

    const ps = [...r.players.values()];
    const has = t => ps.some(p => p.team === t);

    // Start match when both teams are present.
    if (!r.started && !r.over && has('blue') && has('red')) {
      r.started = true;
      r.left = MATCH;
    }

    // Match timer.
    if (r.started && !r.over) {
      r.left -= dt;

      const full = ['blue', 'red'].find(
        t => r.dead[t].size >= TOTAL
      );

      if (r.left <= 0 || full) {
        r.over = true;
        r.left = Math.max(0, r.left);
        r.resetAt = now + 15000;

        const b = pts(r, 'blue');
        const d = pts(r, 'red');

        r.winner = full
          ? other(full)
          : b > d
            ? 'blue'
            : d > b
              ? 'red'
              : 'draw';
      }
    }

    // Reset match.
    if (r.over && now >= r.resetAt) {
      r.over = false;
      r.started = has('blue') && has('red');
      r.left = MATCH;
      r.winner = null;

      r.dead = {
        blue: new Set(),
        red: new Set()
      };

      r.kills = {
        blue: 0,
        red: 0
      };

      r.projs = [];
      r.decoys = [];

      io.to(r.code).emit('matchReset');

      for (const p of ps) {
        p.hp = 100;
        p.dead = false;
        p.kills = 0;
        p.deaths = 0;

        io.to(r.code).emit('playerRespawned', spawnMsg(p));
      }
    }

    // Player respawn and guns.
    for (const p of ps) {
      if (p.dead && !r.over && now >= p.deadAt + 8000) {
        p.hp = 100;
        p.dead = false;

        io.to(r.code).emit('playerRespawned', spawnMsg(p));
      }

      if (p.gun && !p.dead && p.state && !r.over) {
        p.gc -= dt;

        while (p.gc <= 0) {
          p.gc += 0.04;

          const f = fwd(p.state);
          const id = ++r.pid;

          const v = [
            f[0] * 1000 + p.state.vx,
            f[1] * 1000 + p.state.vy,
            f[2] * 1000 + p.state.vz
          ];

          const b = {
            id,
            type: 'bullet',
            owner: p.id,
            team: p.team,
            x: p.state.x + f[0] * 9,
            y: p.state.y + f[1] * 9,
            z: p.state.z + f[2] * 9,
            v,
            life: 2.2
          };

          r.projs.push(b);

          io.to(r.code).emit('projectileSpawn', {
            id,
            weapon: 'gun',
            team: p.team,
            x: b.x,
            y: b.y,
            z: b.z,
            vx: v[0],
            vy: v[1],
            vz: v[2]
          });
        }
      } else {
        p.gc = 0;
      }
    }

    // Projectile simulation.
    r.projs = r.projs.filter(m => {
      const end = h => {
        io.to(r.code).emit('projectileEnd', {
          id: m.id,
          hit: h,
          weapon: m.type === 'gun' ? 'gun' : 'missile',
          x: m.x,
          y: m.y,
          z: m.z
        });

        return false;
      };

      const ox = m.x;
      const oy = m.y;
      const oz = m.z;

      m.life -= dt;

      // Missile guidance.
      if (m.type === 'missile') {
        const t = r.players.get(m.tid);

        if (t && !t.dead && t.state) {
          const dx = t.state.x - m.x;
          const dy = t.state.y - m.y;
          const dz = t.state.z - m.z;

          const range = Math.hypot(dx, dy, dz);

          if (range <= 2000) {
            const sp = Math.min(
              430,
              Math.hypot(...m.v) + 48 * dt
            );

            const cur = norm(m.v);
            const want = norm([dx, dy, dz]);

            m.v = norm(
              cur.map((c, i) => c + (want[i] - c) * 0.08)
            ).map(c => c * sp);
          }
        }
      }

      // Move projectile.
      m.x += m.v[0] * dt;
      m.y += m.v[1] * dt;
      m.z += m.v[2] * dt;

      // Enforce 2 km maximum missile travel.
      if (m.type === 'missile') {
        m.travelled += Math.hypot(
          m.x - ox,
          m.y - oy,
          m.z - oz
        );

        if (m.travelled >= m.maxRange) {
          return end(false);
        }
      }

      if (m.y < 0 || m.life <= 0) {
        return end(false);
      }

      // Collision detection.
      for (const t of ps) {
        if (t.team === m.team || t.dead || !t.state) continue;

        const d = [
          m.x - ox,
          m.y - oy,
          m.z - oz
        ];

        const w = [
          t.state.x - ox,
          t.state.y - oy,
          t.state.z - oz
        ];

        const l2 =
          d[0] * d[0] +
          d[1] * d[1] +
          d[2] * d[2] || 1e-6;

        const u = Math.max(
          0,
          Math.min(
            1,
            (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / l2
          )
        );

        const dist = Math.hypot(
          ox + d[0] * u - t.state.x,
          oy + d[1] * u - t.state.y,
          oz + d[2] * u - t.state.z
        );

        if (dist < (m.type === 'missile' ? 30 : 14)) {
          hit(
            r,
            t,
            r.players.get(m.owner),
            m.type === 'missile' ? 70 : 6,
            m.type === 'gun' ? 'gun' : 'missile'
          );

          return end(true);
        }
      }

      if (m.type === 'missile') {
        io.to(r.code).emit('projectileUpdate', {
          id: m.id,
          x: m.x,
          y: m.y,
          z: m.z,
          vx: m.v[0],
          vy: m.v[1],
          vz: m.v[2]
        });
      }

      return true;
    });

    // Combat state updates.
    if (tick % 4 === 0) {
      io.to(r.code).emit('combatState', {
        players: ps.map(p => ({
          id: p.id,
          name: p.name,
          team: p.team,
          hp: p.hp,
          dead: p.dead,
          kills: p.kills,
          deaths: p.deaths,
          missiles: 4,
          gunAmmo: 511
        }))
      });
    }

    // Match state updates.
    if (tick % 10 === 0) {
      io.to(r.code).emit('matchState', {
        left: r.left,
        started: r.started,
        over: r.over,
        winner: r.winner,
        dead: {
          blue: [...r.dead.blue],
          red: [...r.dead.red]
        },
        pts: {
          blue: pts(r, 'blue'),
          red: pts(r, 'red')
        },
        kills: r.kills
      });
    }
  }
}, 50);

srv.listen(process.env.PORT || 3000, () => {
  console.log(
    'Jet game on http://localhost:' + (process.env.PORT || 3000)
  );
});
