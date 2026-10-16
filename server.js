'use strict';
/*
 * Velocity GP — LAN multiplayer racing server
 *
 * - Express serves the client from /public.
 * - A WebSocket server (path /ws) handles rooms, lobbies and races.
 * - The server is authoritative for race state: timer, checkpoints, laps,
 *   positions and results. Clients only report where their own car is.
 * - AI cars are simulated here with the same physics code the clients use
 *   (public/shared.js) and broadcast like any other car.
 */

const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const S = require('./public/shared.js');
const C = S.C;

// ============================================================
// CONFIG
// ============================================================
// Hosts like Render/Railway assign the port via $PORT; locally we default to 3000.
const PORT = Number(process.env.PORT) || 3000;
// Public address when deployed (Render and Railway set these automatically;
// PUBLIC_URL can be set by hand on any other host). Empty when run locally.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/+$/, '');
const HEARTBEAT_MS = 25000;       // protocol-level ping/pong; dead sockets are terminated
const CLIENT_SILENT_MS = 10000;   // clients answer the 2 s app ping, so 10 s of silence = gone
const TICK_DT = 1 / C.TICK_RATE;
const NET_EVERY = Math.round(C.TICK_RATE / C.NET_RATE); // broadcast every N ticks (60/20 = 3)
const COUNTDOWN_LEAD_MS = 1500;   // time for clients to load the race before light 1
const LIGHT_INTERVAL_MS = 1000;
const MAX_RACE_SECONDS_PER_LAP = 240;

const TRACKS = S.TRACK_DEFS.map((d, i) => S.buildTrack(d, i));
const AI_LEVELS = {
  easy:   { pace: 0.80, wobble: 0.10 },
  medium: { pace: 0.90, wobble: 0.04 },
  hard:   { pace: 0.975, wobble: 0 }
};

// ============================================================
// HTTP + WEBSOCKET SETUP
// ============================================================
const app = express();
// Health check for the hosting platform's load balancer / uptime monitor.
app.get('/health', (req, res) => {
  let players = 0;
  for (const room of rooms.values()) players += room.players.size;
  res.set('Cache-Control', 'no-store').json({
    status: 'ok', uptime: Math.round(process.uptime()), rooms: rooms.size, players, clients: wss.clients.size
  });
});
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
    }
  }
  return out;
}
// Addresses players should use to join: the public URL when deployed, LAN IPs when local.
const lanUrls = () => PUBLIC_URL ? [PUBLIC_URL] : lanAddresses().map(ip => `http://${ip}:${PORT}`);

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

// ============================================================
// ROOMS / LOBBY
// ============================================================
const rooms = new Map();
let idCounter = 1;
const uid = () => (idCounter++).toString(36) + Math.random().toString(36).slice(2, 6);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; } while (rooms.has(c));
  return c;
}

const cleanName = n => String(n || '').replace(/[<>&"]/g, '').trim().slice(0, 16);

function createRoom(isPrivate) {
  const room = {
    code: makeCode(),
    isPrivate: !!isPrivate,     // single-player rooms are private (not listed, pausable)
    hostId: null,
    players: new Map(),
    settings: { track: 0, laps: C.DEFAULT_LAPS, difficulty: 'medium', aiFill: true },
    state: 'lobby',             // 'lobby' | 'racing'
    race: null,
    lastResults: null
  };
  rooms.set(room.code, room);
  return room;
}

function freeTeam(room, exceptId) {
  const used = new Set([...room.players.values()].filter(p => p.id !== exceptId).map(p => p.team));
  for (let t = 0; t < S.TEAMS.length; t++) if (!used.has(t)) return t;
  return 0;
}

function addPlayer(room, ws, name, token) {
  const p = {
    id: uid(), token: String(token || uid()), name: cleanName(name) || 'Driver',
    team: freeTeam(room), ready: false, ws, connected: true, ping: 0, removeTimer: null
  };
  room.players.set(p.id, p);
  if (!room.hostId) room.hostId = p.id;
  attach(ws, room, p);
  return p;
}

function attach(ws, room, p) {
  ws.player = p;
  ws.room = room;
  p.ws = ws;
  p.connected = true;
  clearTimeout(p.removeTimer);
  p.removeTimer = null;
}

function lobbyMsg(room) {
  return {
    type: 'lobbyUpdate',
    code: room.code,
    isPrivate: room.isPrivate,
    hostId: room.hostId,
    state: room.state,
    settings: room.settings,
    maxPlayers: C.MAX_PLAYERS,
    lastResults: room.lastResults,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, team: p.team,
      ready: p.ready || p.id === room.hostId,
      isHost: p.id === room.hostId,
      ping: p.ping, connected: p.connected
    }))
  };
}
const broadcastLobby = room => broadcast(room, lobbyMsg(room));

function roomListMsg() {
  const list = [];
  for (const r of rooms.values()) {
    if (r.isPrivate) continue;
    const host = r.players.get(r.hostId);
    list.push({
      code: r.code, host: host ? host.name : '?', players: r.players.size,
      max: C.MAX_PLAYERS, state: r.state, track: TRACKS[r.settings.track].name
    });
  }
  return { type: 'roomList', rooms: list };
}

function deleteRoom(room) {
  if (room.race) for (const t of room.race.timers) clearTimeout(t);
  for (const p of room.players.values()) clearTimeout(p.removeTimer);
  rooms.delete(room.code);
}

// Permanently remove a player (explicit leave or reconnect grace expired).
function removePlayer(room, p) {
  if (!room.players.has(p.id)) return;
  clearTimeout(p.removeTimer);
  room.players.delete(p.id);
  if (p.ws && p.ws.player === p) { p.ws.player = null; p.ws.room = null; }

  // Mid-race: an AI driver takes over their car so the race carries on.
  const car = room.race && room.race.cars.find(c => c.playerId === p.id);
  if (car && !car.aiControlled) takeOverWithAI(car, room.race.track);
  if (room.race) broadcast(room, { type: 'playerLeft', id: p.id, name: p.name, carId: car ? car.id : null, permanent: true });

  // Hand host control to the next (preferably connected) player.
  if (room.hostId === p.id) {
    const next = [...room.players.values()].find(q => q.connected) || room.players.values().next().value;
    room.hostId = next ? next.id : null;
    if (next) next.ready = true;
  }
  if (room.players.size === 0) { deleteRoom(room); return; }
  broadcastLobby(room);
}

function onDisconnect(ws) {
  const p = ws.player, room = ws.room;
  if (!p || !room || p.ws !== ws) return;   // already replaced by a reconnect
  p.connected = false;
  p.ws = null;
  const race = room.race;
  const car = race && race.cars.find(c => c.playerId === p.id);
  if (car && room.isPrivate && race.phase === 'racing') {
    race.paused = true;   // single player: freeze the race until they're back
  } else if (car && !car.aiControlled) {
    takeOverWithAI(car, race.track);
    broadcast(room, { type: 'playerLeft', id: p.id, name: p.name, carId: car.id, permanent: false });
  }
  // Keep their slot for a while so they can reconnect into the same room/car.
  p.removeTimer = setTimeout(() => removePlayer(room, p), C.RECONNECT_GRACE_MS);
  broadcastLobby(room);
}

function leaveCurrentRoom(ws) {
  if (ws.player && ws.room) removePlayer(ws.room, ws.player);
  ws.player = null;
  ws.room = null;
}

// ============================================================
// MESSAGE HANDLERS (client -> server)
// ============================================================
const handlers = {
  listRooms(ws) { send(ws, roomListMsg()); },

  createRoom(ws, m) {
    const name = cleanName(m.name);
    if (!name) return send(ws, { type: 'error', reason: 'name', message: 'Please enter a name first.' });
    leaveCurrentRoom(ws);
    const room = createRoom(m.isPrivate);
    const p = addPlayer(room, ws, name, m.token);
    if (Number.isInteger(m.team) && m.team >= 0 && m.team < S.TEAMS.length) p.team = m.team;
    send(ws, { type: 'roomJoined', code: room.code, playerId: p.id });
    broadcastLobby(room);
  },

  joinRoom(ws, m) {
    const name = cleanName(m.name);
    const code = String(m.code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!name) return send(ws, { type: 'error', reason: 'name', message: 'Please enter a name first.' });
    if (!room || room.isPrivate) return send(ws, { type: 'error', reason: 'notfound', message: `Room "${code}" doesn't exist. Check the code and try again.` });
    const existing = [...room.players.values()].find(p => p.token === String(m.token));
    if (existing) return handlers.rejoin(ws, { code, token: m.token });
    if (room.state !== 'lobby') return send(ws, { type: 'error', reason: 'started', message: `Room ${code} is mid-race. Wait for it to finish, then join.` });
    if (room.players.size >= C.MAX_PLAYERS) return send(ws, { type: 'error', reason: 'full', message: `Room ${code} is full (${C.MAX_PLAYERS}/${C.MAX_PLAYERS}).` });
    leaveCurrentRoom(ws);
    const p = addPlayer(room, ws, name, m.token);
    if (Number.isInteger(m.team) && m.team >= 0 && m.team < S.TEAMS.length &&
        ![...room.players.values()].some(q => q !== p && q.team === m.team)) p.team = m.team;
    send(ws, { type: 'roomJoined', code: room.code, playerId: p.id });
    broadcastLobby(room);
  },

  // Automatic reconnect: same token -> same player slot (and same car if racing).
  rejoin(ws, m) {
    const room = rooms.get(String(m.code || '').toUpperCase());
    const p = room && [...room.players.values()].find(q => q.token === String(m.token));
    if (!p) return send(ws, { type: 'error', reason: 'rejoinFailed', message: 'Could not rejoin — the room has closed or your slot expired.' });
    if (p.ws && p.ws !== ws) { const old = p.ws; old.player = null; old.room = null; try { old.terminate(); } catch (e) { /* ignore */ } }
    if (ws.player && ws.player !== p) leaveCurrentRoom(ws);
    attach(ws, room, p);
    const race = room.race;
    const car = race && race.cars.find(c => c.playerId === p.id);
    send(ws, { type: 'roomJoined', code: room.code, playerId: p.id, rejoined: true, inRace: !!car });
    broadcastLobby(room);
    if (car) {
      car.aiControlled = false;     // hand the car back to the human
      car.ai = null;
      car.lastUpdate = Date.now();
      send(ws, raceInitMsg(race, car));
      broadcast(room, { type: 'playerRejoined', id: p.id, name: p.name });
    }
  },

  leaveRoom(ws) { leaveCurrentRoom(ws); },

  setSettings(ws, m) {
    const room = ws.room, p = ws.player;
    if (!room || room.hostId !== p.id || room.state !== 'lobby') return;
    const s = room.settings;
    if (Number.isInteger(m.track) && TRACKS[m.track]) s.track = m.track;
    if (Number.isInteger(m.laps)) s.laps = S.clamp(m.laps, 1, 10);
    if (AI_LEVELS[m.difficulty]) s.difficulty = m.difficulty;
    if (typeof m.aiFill === 'boolean') s.aiFill = m.aiFill;
    broadcastLobby(room);
  },

  setTeam(ws, m) {
    const room = ws.room, p = ws.player;
    if (!room || room.state !== 'lobby' || !Number.isInteger(m.team) || !S.TEAMS[m.team]) return;
    const owner = [...room.players.values()].find(q => q.team === m.team && q !== p);
    if (owner) return send(ws, { type: 'error', reason: 'team', message: `${S.TEAMS[m.team].name} is already taken by ${owner.name}.` });
    p.team = m.team;
    broadcastLobby(room);
  },

  ready(ws, m) {
    const room = ws.room;
    if (!room || room.state !== 'lobby') return;
    ws.player.ready = !!m.ready;
    broadcastLobby(room);
  },

  startRace(ws) {
    const room = ws.room, p = ws.player;
    if (!room || room.hostId !== p.id || room.state !== 'lobby') return;
    const others = [...room.players.values()].filter(q => q.id !== room.hostId);
    if (others.some(q => !q.connected)) return send(ws, { type: 'error', reason: 'notReady', message: 'Waiting for a player to reconnect.' });
    if (others.some(q => !q.ready)) return send(ws, { type: 'error', reason: 'notReady', message: 'Everyone must be ready first.' });
    startRace(room);
  },

  // Each client reports its own car ~20x/s. We sanity-check the movement and
  // then run lap/checkpoint logic here, so lap counts can't be faked.
  carState(ws, m) {
    const room = ws.room, p = ws.player, race = room && room.race;
    if (!race || race.phase !== 'racing') return;
    const car = race.cars.find(c => c.playerId === p.id);
    if (!car || car.aiControlled) return;
    const nums = [m.x, m.y, m.a, m.vx, m.vy];
    if (!nums.every(Number.isFinite)) return;
    const now = Date.now();
    const dt = Math.max(0.001, (now - car.lastUpdate) / 1000);
    const moved = Math.hypot(m.x - car.x, m.y - car.y);
    let ok = moved <= C.MAX_SPEED * C.DRS_BOOST * 1.4 * dt + 60;
    if (!ok && m.rs) {
      // "Reset to track" is allowed if it lands on the centreline near where the car was.
      const nr = S.nearest(race.track, m.x, m.y, car.idx);
      const di = Math.abs(nr.idx - car.idx);
      ok = nr.d < 30 && Math.min(di, race.track.N - di) < 45;
    }
    if (race.paused) ok = moved < 5;
    if (!ok) {
      send(ws, { type: 'correction', x: car.x, y: car.y, a: car.a });
      return;
    }
    car.x = m.x; car.y = m.y; car.a = m.a; car.vx = m.vx; car.vy = m.vy;
    car.tyre = S.clamp(Number(m.ty) || 1, C.TYRE_MIN, 1);
    car.drsTime = m.drs ? 1 : 0;
    car.braking = !!m.br;
    car.lastUpdate = now;
    updateProgress(room, car);
  },

  pauseRace(ws, m) {
    const room = ws.room, race = room && room.race;
    if (!race || !room.isPrivate || race.phase !== 'racing') return;
    race.paused = !!m.paused;
    broadcast(room, { type: 'paused', paused: race.paused });
  },

  pong(ws, m) {
    if (ws.player && Number.isFinite(m.t)) ws.player.ping = Math.max(0, Date.now() - m.t);
  }
};

// ============================================================
// RACE CONTROL (server-authoritative)
// ============================================================
function newCar(id, entry, slot) {
  return {
    id, playerId: entry.playerId, name: entry.name, team: entry.team,
    isAI: entry.isAI, aiControlled: entry.isAI, ai: entry.isAI ? newAI() : null,
    x: slot.x, y: slot.y, a: slot.a, vx: 0, vy: 0, idx: slot.idx,
    tyre: 1, drsTime: 0, drsAvail: true, braking: false, slip: 0,
    lap: 0,            // completed laps
    nextCp: 1,         // next checkpoint to pass (CHECKPOINTS = "go to the line")
    lapStart: 0, lastLap: null, bestLap: null,
    finished: false, finishTime: null, finishPos: 0,
    progress: 0, pos: 0, lastUpdate: Date.now()
  };
}

function startRace(room) {
  const s = room.settings, tr = TRACKS[s.track];
  const entries = [...room.players.values()].filter(p => p.connected)
    .map(p => ({ playerId: p.id, name: p.name, team: p.team, isAI: false }));
  if (s.aiFill) {
    const used = new Set(entries.map(e => e.team));
    const names = shuffle(S.AI_NAMES.slice());
    for (let t = 0; t < S.TEAMS.length && entries.length < C.MAX_PLAYERS; t++) {
      if (!used.has(t)) entries.push({ playerId: null, name: names.pop(), team: t, isAI: true });
    }
  }
  shuffle(entries);
  const race = {
    trackId: s.track, track: tr, profile: speedProfile(tr), laps: s.laps,
    level: AI_LEVELS[s.difficulty] || AI_LEVELS.medium,
    cars: entries.map((e, k) => newCar('c' + k, e, tr.grid[k])),
    phase: 'countdown', raceTime: 0, paused: false, tick: 0,
    finishOrder: 0, firstFinish: null, timers: []
  };
  race.cars.forEach((c, k) => { c.pos = k + 1; c.progress = -k; });
  room.race = race;
  room.state = 'racing';
  for (const p of room.players.values()) {
    const car = race.cars.find(c => c.playerId === p.id);
    if (car) send(p.ws, raceInitMsg(race, car));
  }
  broadcastLobby(room);

  // Synchronised start: the server drives the five red lights, then a random
  // hold before lights out, so every client launches on the same message.
  for (let n = 1; n <= 5; n++) {
    race.timers.push(setTimeout(() => {
      if (room.race === race) broadcast(room, { type: 'lights', n });
    }, COUNTDOWN_LEAD_MS + (n - 1) * LIGHT_INTERVAL_MS));
  }
  const goAt = COUNTDOWN_LEAD_MS + 4 * LIGHT_INTERVAL_MS + 600 + Math.random() * 1400;
  race.timers.push(setTimeout(() => {
    if (room.race !== race) return;
    race.phase = 'racing';
    race.raceTime = 0;
    const now = Date.now();
    for (const c of race.cars) c.lastUpdate = now;
    broadcast(room, { type: 'go' });
  }, goAt));
}

function raceInitMsg(race, car) {
  return {
    type: 'raceInit',
    trackId: race.trackId,
    laps: race.laps,
    phase: race.phase,
    raceTime: race.raceTime,
    paused: race.paused,
    yourCarId: car.id,
    cars: race.cars.map(c => ({ id: c.id, name: c.name, team: c.team, isAI: c.isAI, playerId: c.playerId, x: c.x, y: c.y, a: c.a })),
    // Present when reconnecting mid-race: where the car is now.
    resume: race.phase === 'racing'
      ? { x: car.x, y: car.y, a: car.a, vx: car.vx, vy: car.vy, tyre: car.tyre, drsAvail: car.drsAvail, finished: car.finished, lap: car.lap, bestLap: car.bestLap }
      : null
  };
}

// Checkpoints: the lap is split into CHECKPOINTS equal sections. A car must
// reach each one in order; only then does crossing the line count as a lap.
function updateProgress(room, car) {
  const race = room.race, tr = race.track;
  const nr = S.nearest(tr, car.x, car.y, car.idx);
  car.idx = nr.idx;
  const s = nr.idx / tr.N, CP = C.CHECKPOINTS;
  if (!car.finished) {
    if (car.nextCp < CP) {
      const cpS = car.nextCp / CP;
      if (s >= cpS && s < cpS + 0.07) car.nextCp++;
    } else if (s < 0.07) {
      completeLap(room, car);
    }
  }
  car.progress = car.lap * tr.length + nr.along;
  if (car.nextCp === 1 && s > 0.5) car.progress -= tr.length;   // still behind the line
}

function completeLap(room, car) {
  const race = room.race;
  const lapTime = race.raceTime - car.lapStart;
  car.lap++;
  car.lastLap = lapTime;
  if (car.bestLap == null || lapTime < car.bestLap) car.bestLap = lapTime;
  car.lapStart = race.raceTime;
  car.nextCp = 1;
  car.drsAvail = true;
  broadcast(room, { type: 'lapCompleted', id: car.id, name: car.name, lap: car.lap, time: lapTime, best: car.bestLap, ai: car.aiControlled });
  if (car.lap >= race.laps) {
    car.finished = true;
    car.finishTime = race.raceTime;
    car.finishPos = ++race.finishOrder;
    if (race.firstFinish == null) race.firstFinish = race.raceTime;
    broadcast(room, { type: 'carFinished', id: car.id, name: car.name, pos: car.finishPos, time: car.finishTime });
  }
}

function updatePositions(race) {
  const sorted = race.cars.slice().sort((a, b) => {
    if (a.finished && b.finished) return a.finishPos - b.finishPos;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.progress - a.progress;
  });
  sorted.forEach((c, i) => { c.pos = i + 1; });
}

function checkRaceEnd(room) {
  const race = room.race;
  const t = race.raceTime;
  const humansDone = race.cars.filter(c => !c.aiControlled).every(c => c.finished);
  const allDone = race.cars.every(c => c.finished);
  const ff = race.firstFinish;
  if ((ff != null && (allDone || (humansDone && t > ff + 6) || t > ff + C.FINISH_TIMEOUT)) ||
      t > race.laps * MAX_RACE_SECONDS_PER_LAP) endRace(room);
}

function endRace(room) {
  const race = room.race;
  updatePositions(race);
  const leaderLaps = Math.max(...race.cars.map(c => c.lap));
  const results = race.cars.slice().sort((a, b) => a.pos - b.pos).map(c => ({
    pos: c.pos, id: c.id, name: c.name, team: c.team, isAI: c.isAI,
    aiTakeover: !c.isAI && c.aiControlled, playerId: c.playerId,
    time: c.finished ? c.finishTime : null, bestLap: c.bestLap, laps: c.lap,
    status: c.finished ? 'FIN' : (leaderLaps > c.lap ? `+${race.laps - c.lap} LAP${race.laps - c.lap > 1 ? 'S' : ''}` : 'DNF')
  }));
  for (const t of race.timers) clearTimeout(t);
  room.race = null;
  room.state = 'lobby';
  room.lastResults = { track: race.track.name, trackId: race.trackId, laps: race.laps, results };
  for (const p of room.players.values()) p.ready = p.id === room.hostId;
  broadcast(room, { type: 'raceFinished', ...room.lastResults });
  broadcastLobby(room);
}

function raceUpdateMsg(race) {
  const r1 = v => Math.round(v * 10) / 10;
  return {
    type: 'raceUpdate',
    t: Math.round(race.raceTime * 1000) / 1000,
    st: Date.now(),             // server clock, used by clients for interpolation
    ph: race.phase,
    cars: race.cars.map(c => ({
      i: c.id, x: r1(c.x), y: r1(c.y), a: Math.round(c.a * 1000) / 1000, vx: r1(c.vx), vy: r1(c.vy),
      l: c.lap, p: c.pos, b: c.bestLap, ls: c.lapStart, ty: Math.round(c.tyre * 100) / 100,
      // bit flags: 1 finished, 2 DRS open, 4 braking, 8 AI-driven
      f: (c.finished ? 1 : 0) | (c.drsTime > 0 ? 2 : 0) | (c.braking ? 4 : 0) | (c.aiControlled ? 8 : 0)
    }))
  };
}

function tickRoom(room, dt) {
  const race = room.race;
  if (!race) return;
  race.tick++;
  if (race.phase === 'racing' && !race.paused) {
    race.raceTime += dt;
    for (const car of race.cars) {
      if (!car.aiControlled) continue;
      const inp = aiInput(car, race, dt);
      S.stepCar(car, inp, dt, race.track);
      car.braking = inp.brake > 0.1;
    }
    // Collisions: the server only moves AI cars. Human cars are moved by their
    // own client (which applies the other half of the same collision).
    for (let i = 0; i < race.cars.length; i++) {
      for (let j = i + 1; j < race.cars.length; j++) {
        const a = race.cars[i], b = race.cars[j];
        if (!a.aiControlled && !b.aiControlled) continue;
        S.collideCars(a, b, a.aiControlled ? 0.5 : 0, b.aiControlled ? 0.5 : 0);
      }
    }
    for (const car of race.cars) if (car.aiControlled) updateProgress(room, car);
    updatePositions(race);
    checkRaceEnd(room);
    if (!room.race) return;
  }
  if (race.tick % NET_EVERY === 0) broadcast(room, raceUpdateMsg(race));
}

// ============================================================
// AI DRIVERS
// Each AI follows the centreline (plus its own lane offset) using "pure
// pursuit" steering towards a point ahead, and controls speed from a
// precomputed speed profile: the fastest safe speed at every point of the
// track given its curvature and the braking distance to the next corner.
// ============================================================
const profileCache = new Map();
function speedProfile(tr) {
  if (profileCache.has(tr.id)) return profileCache.get(tr.id);
  const N = tr.N, v = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    v[i] = Math.min(C.MAX_SPEED, Math.sqrt((C.GRIP * 0.86) / Math.max(tr.curvAbs[i], 1e-6)));
  }
  // Backwards pass: make sure we can brake in time for every corner.
  const dec = C.BRAKE * 0.6;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = N - 1; i >= 0; i--) {
      const lim = Math.sqrt(v[(i + 1) % N] ** 2 + 2 * dec * tr.spacing);
      if (v[i] > lim) v[i] = lim;
    }
  }
  profileCache.set(tr.id, v);
  return v;
}

function newAI() {
  return { lane: (Math.random() * 2 - 1) * 22, offset: 0, phase: Math.random() * Math.PI * 2, stuck: 0 };
}

// A human's car (disconnected or left) is handed to an AI driver, which
// keeps the car's current lateral position on track as its lane.
function takeOverWithAI(car, tr) {
  car.aiControlled = true;
  car.ai = newAI();
  car.ai.offset = S.clamp(S.nearest(tr, car.x, car.y, car.idx).lat, -50, 50);
}

function aiInput(car, race, dt) {
  const tr = race.track, N = tr.N, P = tr.pts, lvl = race.level;
  const ai = car.ai || (car.ai = newAI());
  const ca = Math.cos(car.a), sa = Math.sin(car.a);
  const vF = car.vx * ca + car.vy * sa;
  const speed = Math.abs(vF);

  // 1. Traffic: if a car is just ahead in our lane, move over and/or lift.
  let avoid = 0, lift = false;
  for (const o of race.cars) {
    if (o === car) continue;
    const dx = o.x - car.x, dy = o.y - car.y;
    if (dx * dx + dy * dy > 160 * 160) continue;
    const f = dx * ca + dy * sa, l = -dx * sa + dy * ca;
    if (f > 0 && f < 140 && Math.abs(l) < 34) {
      avoid += (l >= 0 ? -1 : 1) * (1 - f / 140);
      const ov = o.vx * ca + o.vy * sa;
      if (f < 60 && ov < vF - 20) lift = true;
    }
  }
  const maxOff = tr.halfW - 28;
  const wobble = Math.sin(race.raceTime * 0.35 + ai.phase) * 18;
  const target = S.clamp(ai.lane + wobble + avoid * 60, -maxOff, maxOff);
  ai.offset += S.clamp(target - ai.offset, -90 * dt, 90 * dt);

  // 2. Steering: aim at a point further ahead the faster we go.
  const ti = (car.idx + 5 + Math.round(speed * 0.03)) % N;
  const tx = P[ti].x + tr.nx[ti] * ai.offset, ty = P[ti].y + tr.ny[ti] * ai.offset;
  const err = S.wrapAngle(Math.atan2(ty - car.y, tx - car.x) - car.a);
  let steer = S.clamp(err * 3, -1, 1);
  if (lvl.wobble) steer = S.clamp(steer + Math.sin(race.raceTime * 1.7 + ai.phase) * lvl.wobble, -1, 1);

  // 3. Speed: follow the profile, scaled by difficulty.
  let vt = Infinity;
  for (let k = 0; k <= 6; k += 2) vt = Math.min(vt, race.profile[(car.idx + k) % N]);
  vt *= lvl.pace * (car.finished ? 0.6 : 1);
  if (car.surface === 'grass') vt = Math.min(vt, C.MAX_SPEED * C.GRASS_SPEED);
  let throttle = 0, brake = 0;
  if (vF < -5) throttle = 1;
  else if (speed < vt - 10) throttle = 1;
  else if (speed > vt + 20) brake = Math.min(1, (speed - vt) / 120);
  else throttle = 0.4;
  if (lift) throttle = Math.min(throttle, 0.3);

  // 4. Recovery: if stuck (e.g. nose into a wall), put the car back on track.
  if (speed < 30 && race.raceTime > 3) ai.stuck += dt; else ai.stuck = Math.max(0, ai.stuck - dt);
  if (ai.stuck > 2.5) {
    const i = car.idx;
    car.x = P[i].x; car.y = P[i].y; car.a = tr.heading[i]; car.vx = car.vy = 0;
    ai.stuck = 0;
  }

  const drs = car.drsAvail && Math.abs(err) < 0.1 && S.inDrsZone(tr, car.idx);
  return { throttle, brake, steer, drs };
}

// ============================================================
// WEBSOCKET CONNECTIONS
// ============================================================
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.lastSeen = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { type: 'welcome', urls: lanUrls(), port: PORT });
  ws.on('message', data => {
    ws.lastSeen = Date.now();
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.type !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, m.type)) return;
    // Everything except these needs the socket to be in a room.
    if (!['listRooms', 'createRoom', 'joinRoom', 'rejoin', 'pong'].includes(m.type) && !ws.player) return;
    try { handlers[m.type](ws, m); } catch (e) { console.error(`Error handling "${m.type}":`, e); }
  });
  ws.on('close', () => onDisconnect(ws));
  ws.on('error', () => {});
});

// Fixed-rate simulation loop (60 Hz) driven by an accumulator so the tick
// rate stays stable even if setInterval fires late.
let last = process.hrtime.bigint(), acc = 0;
setInterval(() => {
  const now = process.hrtime.bigint();
  acc += Number(now - last) / 1e9;
  last = now;
  let steps = 0;
  while (acc >= TICK_DT && steps < 5) {
    for (const room of rooms.values()) tickRoom(room, TICK_DT);
    acc -= TICK_DT;
    steps++;
  }
  if (steps === 5) acc = 0;   // way behind: drop time instead of spiralling
}, 1000 / C.TICK_RATE / 2);

// Every 2 s: app-level ping for latency display (+ lobby refresh so pings show).
setInterval(() => {
  const t = Date.now();
  for (const ws of wss.clients) {
    // A client that stopped answering app pings is gone (closed laptop, lost Wi-Fi):
    // drop it now so an AI takes over its car quickly, without waiting for the heartbeat.
    if (t - ws.lastSeen > CLIENT_SILENT_MS) { ws.terminate(); continue; }
    send(ws, { type: 'ping', t, ping: ws.player ? ws.player.ping : null });
  }
  for (const room of rooms.values()) if (room.state === 'lobby') broadcastLobby(room);
}, 2000);

// Every 25 s: protocol-level ping/pong heartbeat. A socket that didn't answer the
// previous ping is dead and gets terminated (its 'close' handler then cleans up the
// player). The traffic also keeps hosting proxies from closing idle connections.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

// ============================================================
// STARTUP
// ============================================================
function onListenError(e) {
  if (e.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is already in use. Close the other program or run with another port, e.g.  PORT=3001 npm start\n`);
  else console.error(e);
  process.exit(1);
}
server.on('error', onListenError);
wss.on('error', () => {});   // listen errors are reported by the http server handler above

server.listen(PORT, '0.0.0.0', () => {
  const urls = lanUrls();
  console.log('\n  🏁  Velocity GP server is running\n');
  if (PUBLIC_URL) console.log(`  Listening on port ${PORT}. Players can join at ${PUBLIC_URL}`);
  else {
    console.log(`  On this computer:          http://localhost:${PORT}`);
    if (urls.length) for (const u of urls) console.log(`  Players on your Wi-Fi can join at ${u}`);
    else console.log('  (No network interface found — are you connected to Wi-Fi?)');
  }
  console.log('\n  Press Ctrl+C to stop.\n');
});
