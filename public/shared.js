/*
 * Velocity GP — shared code
 * Loaded by BOTH the Node server (require) and the browser (<script>), so track
 * geometry, constants and car physics are guaranteed to be identical everywhere.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ============================================================
  // CONFIG
  // Distances are in world pixels, speeds in px/s, times in seconds
  // unless the name says otherwise. 1 m ≈ 8 px.
  // ============================================================
  const C = {
    MAX_PLAYERS: 8,
    TICK_RATE: 60,            // server simulation ticks per second (fixed)
    NET_RATE: 20,             // network updates per second, both directions
    INTERP_DELAY: 100,        // ms: clients render remote cars this far in the past
    DEFAULT_LAPS: 3,
    RECONNECT_GRACE_MS: 20000,// how long a dropped player keeps their slot
    FINISH_TIMEOUT: 40,       // s after the winner finishes before the race is called

    // Car
    CAR_RADIUS: 10,           // car = two circles of this radius...
    CAR_CIRCLE_OFFSET: 12,    // ...placed this far ahead/behind the centre
    MAX_SPEED: 800,
    ACCEL: 520,
    BRAKE: 950,
    REVERSE_ACCEL: 320,
    MAX_REVERSE: 170,
    AIR_DRAG: 0.18,           // proportional drag (1/s)
    ROLL_DRAG: 45,            // constant coasting drag (px/s²)
    TURN_RATE: 2.9,           // max yaw rate (rad/s) at ideal speed
    GRIP: 820,                // max sideways acceleration tyres can hold (px/s²)
    KERB_GRIP: 0.92,
    GRASS_GRIP: 0.55,
    GRASS_SPEED: 0.42,        // top speed multiplier off track
    GRASS_DRAG: 1.6,          // extra proportional drag off track
    WALL_BOUNCE: 0.3,
    WALL_SPEED_KEEP: 0.9,     // speed kept after touching a wall
    CAR_RESTITUTION: 0.35,
    DRS_BOOST: 1.13,          // top speed multiplier with DRS open
    DRS_ACCEL: 1.3,
    DRS_DURATION: 2.8,
    TYRE_WEAR_PER_LAP: 0.07,  // fraction of tyre life lost per lap of distance
    TYRE_SLIP_WEAR: 0.000025, // extra wear per px/s of sliding per second
    TYRE_MIN: 0.3,

    // Track
    TRACK_WIDTH: 150,
    KERB_WIDTH: 14,
    RUNOFF: 120,              // grass between kerb and wall
    SAMPLE_SPACING: 10,       // centreline resolution
    CHECKPOINTS: 8,           // laps only count if all are passed in order
    KMH_PER_PX: 0.45          // px/s -> km/h for the HUD
  };

  // Fictional teams. Each colour can be used by one car per race.
  const TEAMS = [
    { name: 'Aurora GP',         color: '#e8364a' },
    { name: 'Nimbus Motorsport', color: '#2f8cff' },
    { name: 'Verdant Racing',    color: '#19b38a' },
    { name: 'Solaris Speed',     color: '#ff8a1f' },
    { name: 'Phantom Works',     color: '#8b5cf6' },
    { name: 'Ironclad Racing',   color: '#b8c2cc' },
    { name: 'Volt Dynamics',     color: '#f5d000' },
    { name: 'Sakura Velocity',   color: '#ff6fae' }
  ];

  // Fictional AI drivers.
  const AI_NAMES = [
    'Aleks Varga', 'Lio Okonkwo', 'Tove Lindqvist', 'Remy Castell',
    'Kenji Arakawa', 'Sofia Brandt', 'Diego Halloway', 'Nils Petrak',
    'Ines Mardel', 'Oskar Vell', 'Mara Quint', 'Teo Ravelli'
  ];

  // ============================================================
  // TRACK DATA
  // Control points of a closed Catmull-Rom spline. The FIRST point is the
  // start/finish line and must sit on the main straight.
  // ============================================================
  const TRACK_DEFS = [
    {
      name: 'Aurora Park',
      desc: 'Long straight, tight hairpin, quick chicane and flowing sweepers.',
      scale: 1.2,
      theme: { grass: '#4f9d4a', grass2: '#479144', out: '#2f6b34', out2: '#285e2d', bush: '#24552a' },
      points: [
        [1400, 2000], [2200, 2000], [3000, 2000],              // main straight
        [3350, 1930], [3550, 1700],                            // T1 fast sweeper
        [3600, 1350], [3580, 1000],                            // back straight
        [3500, 760], [3330, 640], [3150, 700], [3080, 900],    // hairpin
        [3060, 1150], [2950, 1330], [2700, 1420], [2350, 1420],
        [2100, 1420], [1950, 1330], [1800, 1330], [1650, 1420],// chicane
        [1350, 1440], [1050, 1350], [880, 1150], [850, 900],   // sweepers
        [950, 650], [880, 430], [650, 330], [420, 420],
        [300, 650], [280, 1000], [300, 1400], [330, 1750],
        [480, 1960], [800, 2010]
      ]
    },
    {
      name: 'Kestrel Bay',
      desc: 'Coastal circuit with a right-side chicane, infield hairpin and fast esses.',
      scale: 1.2,
      theme: { grass: '#5aa457', grass2: '#529a4f', out: '#d9c48f', out2: '#cdb77c', bush: '#bfa86c' },
      points: [
        [1300, 400], [2000, 400], [2700, 400],                 // main straight
        [3050, 450], [3200, 650], [3220, 900],                 // T1
        [3220, 1000], [3130, 1100], [3130, 1220], [3220, 1320],// chicane
        [3230, 1600], [3150, 1900], [2950, 2080], [2650, 2130],// long sweeper
        [2250, 2130], [1950, 2050], [1800, 1850], [1780, 1500],
        [1740, 1250], [1600, 1120], [1420, 1150], [1330, 1300],// infield hairpin
        [1320, 1650], [1250, 1950], [1050, 2100],
        [750, 2120], [520, 2000], [400, 1750],
        [430, 1450], [350, 1200], [400, 950],                  // esses
        [450, 700], [600, 480], [850, 400]
      ]
    }
  ];

  // ============================================================
  // MATH HELPERS
  // ============================================================
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;
  function fmtTime(s) {
    if (s == null || !isFinite(s)) return '—';
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    return m + ':' + sec.toFixed(3).padStart(6, '0');
  }

  // Centripetal Catmull-Rom (Barry-Goldman form): no cusps or self-loops
  // even when control points are unevenly spaced.
  function catmull(p0, p1, p2, p3, u) {
    const k = (a, b) => Math.max(1e-4, Math.pow(Math.hypot(b.x - a.x, b.y - a.y), 0.5));
    const t0 = 0, t1 = t0 + k(p0, p1), t2 = t1 + k(p1, p2), t3 = t2 + k(p2, p3);
    const t = t1 + (t2 - t1) * u;
    const L = (a, b, ta, tb) => {
      const w = (t - ta) / (tb - ta);
      return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
    };
    const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
    const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
    return L(B1, B2, t1, t2);
  }

  // Resample a closed polyline into N points spaced (almost) exactly `spacing` apart.
  function resampleClosed(poly, spacing) {
    const n = poly.length, cum = [0];
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      cum.push(cum[i] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    const total = cum[n];
    const N = Math.round(total / spacing);
    const step = total / N, out = [];
    let seg = 0;
    for (let k = 0; k < N; k++) {
      const d = k * step;
      while (cum[seg + 1] < d) seg++;
      const a = poly[seg], b = poly[(seg + 1) % n];
      const w = (d - cum[seg]) / Math.max(1e-6, cum[seg + 1] - cum[seg]);
      out.push({ x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w });
    }
    return { pts: out, step, total };
  }

  // ============================================================
  // TRACK BUILDING
  // Turns control points into a dense centreline with tangents, normals,
  // curvature, kerb flags, a DRS zone and grid slots.
  // ============================================================
  function buildTrack(def, id) {
    const raw = def.points.map(p => ({ x: p[0] * def.scale, y: p[1] * def.scale }));
    const n = raw.length, dense = [];
    for (let i = 0; i < n; i++) {
      const p0 = raw[(i - 1 + n) % n], p1 = raw[i], p2 = raw[(i + 1) % n], p3 = raw[(i + 2) % n];
      for (let s = 0; s < 24; s++) dense.push(catmull(p0, p1, p2, p3, s / 24));
    }
    const rs = resampleClosed(dense, C.SAMPLE_SPACING);
    const pts = rs.pts, N = pts.length;
    const tx = new Float64Array(N), ty = new Float64Array(N);
    const nx = new Float64Array(N), ny = new Float64Array(N);
    const heading = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      tx[i] = (b.x - a.x) / len; ty[i] = (b.y - a.y) / len;
      nx[i] = -ty[i]; ny[i] = tx[i];          // "right-hand" normal in screen space
      heading[i] = Math.atan2(ty[i], tx[i]);
    }
    // Signed curvature (1/radius), lightly smoothed.
    const rawK = new Float64Array(N), curv = new Float64Array(N), curvAbs = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      rawK[i] = wrapAngle(heading[(i + 2) % N] - heading[(i - 2 + N) % N]) / (4 * rs.step);
    }
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -4; k <= 4; k++) s += rawK[(i + k + N) % N];
      curv[i] = s / 9;
    }
    // Conservative |curvature| for the AI's speed planning (max over a window).
    for (let i = 0; i < N; i++) {
      let m = 0;
      for (let k = -5; k <= 5; k++) m = Math.max(m, Math.abs(curv[(i + k + N) % N]));
      curvAbs[i] = m;
    }
    // Kerbs only where the track actually bends.
    const kerb = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (Math.abs(curv[i]) > 1 / 650) for (let k = -5; k <= 5; k++) kerb[(i + k + N) % N] = 1;
    }
    // DRS zone: the low-curvature run around the start line, ending before T1.
    const flat = i => Math.abs(curv[(i + N) % N]) < 1 / 2000;
    let e = 0; while (flat(e + 1) && e < N / 2) e++;
    let b = 0; while (flat(b - 1) && -b < N / 2) b--;
    const drs = { from: (b + 2 + N) % N, to: (e - 18 + N) % N };

    const track = {
      id, name: def.name, desc: def.desc, theme: def.theme,
      pts, N, spacing: rs.step, length: rs.total,
      tx, ty, nx, ny, heading, curv, curvAbs, kerb, drs,
      halfW: C.TRACK_WIDTH / 2
    };
    track.grid = [];
    for (let k = 0; k < C.MAX_PLAYERS; k++) track.grid.push(gridSlot(track, k));
    return track;
  }

  // Staggered F1-style grid behind the start line.
  function gridSlot(tr, k) {
    const back = 70 + k * 58;
    const i = (tr.N - Math.round(back / tr.spacing)) % tr.N;
    const side = k % 2 === 0 ? -1 : 1;
    const p = tr.pts[i];
    return { x: p.x + tr.nx[i] * side * 32, y: p.y + tr.ny[i] * side * 32, a: tr.heading[i], idx: i };
  }

  function inDrsZone(tr, idx) {
    const N = tr.N;
    const rel = (idx - tr.drs.from + N) % N;
    const len = (tr.drs.to - tr.drs.from + N) % N;
    return rel <= len;
  }

  // Nearest centreline sample. With a hint (previous index) only a small
  // window is searched, which is fast and stops the result jumping to a
  // different part of the track that happens to be close by.
  const NEAR_WIN = 40;
  function nearest(tr, x, y, hint) {
    const P = tr.pts, N = tr.N;
    let bi = -1, bd = Infinity;
    if (hint != null && hint >= 0) {
      for (let k = -NEAR_WIN; k <= NEAR_WIN; k++) {
        let i = hint + k;
        if (i < 0) i += N; else if (i >= N) i -= N;
        const dx = P[i].x - x, dy = P[i].y - y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bi = i; }
      }
    }
    const lim = tr.halfW + C.RUNOFF + 60;
    if (bi < 0 || bd > lim * lim) {
      for (let i = 0; i < N; i++) {
        const dx = P[i].x - x, dy = P[i].y - y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bi = i; }
      }
    }
    const p = P[bi], dx = x - p.x, dy = y - p.y;
    return {
      idx: bi,
      d: Math.sqrt(bd),
      lat: dx * tr.nx[bi] + dy * tr.ny[bi],
      along: bi * tr.spacing + dx * tr.tx[bi] + dy * tr.ty[bi]
    };
  }

  function surfaceOf(tr, nr) {
    if (nr.d <= tr.halfW) return 'track';
    if (nr.d <= tr.halfW + C.KERB_WIDTH && tr.kerb[nr.idx]) return 'kerb';
    if (nr.d <= tr.halfW + C.RUNOFF) return 'grass';
    return 'wall';
  }

  // ============================================================
  // PHYSICS
  // Arcade bicycle-ish model. Velocity is split into a forward part (engine,
  // brakes, drag) and a sideways part that the tyres try to cancel. Tyres can
  // only cancel GRIP px/s² of sideways motion, so turning hard at speed (or on
  // worn tyres / grass) leaves some sideways velocity behind: that's the drift.
  //
  // car:   { x, y, a, vx, vy, idx, tyre, drsTime, drsAvail }
  // input: { throttle 0..1, brake 0..1, steer -1..1, drs bool }
  // Returns the wall impact speed (0 if no wall hit). Sets car.surface/slip.
  // ============================================================
  function stepCar(car, inp, dt, tr) {
    const nr0 = nearest(tr, car.x, car.y, car.idx);
    car.idx = nr0.idx;
    const surf = surfaceOf(tr, nr0);
    const offTrack = surf === 'grass' || surf === 'wall';

    let ca = Math.cos(car.a), sa = Math.sin(car.a);
    let vF = car.vx * ca + car.vy * sa;     // forward speed
    let vS = -car.vx * sa + car.vy * ca;    // sideways speed

    const thr = inp.throttle || 0, brk = inp.brake || 0;

    // DRS: only inside the zone, once per lap, cancelled by braking.
    if (car.drsTime > 0) {
      car.drsTime -= dt;
      if (brk > 0.1 || offTrack) car.drsTime = 0;
    }
    if (inp.drs && car.drsAvail && car.drsTime <= 0 && surf === 'track' && vF > 200 && inDrsZone(tr, car.idx)) {
      car.drsTime = C.DRS_DURATION;
      car.drsAvail = false;
    }
    const drs = car.drsTime > 0;

    const grip = (0.78 + 0.22 * car.tyre) * (offTrack ? C.GRASS_GRIP : surf === 'kerb' ? C.KERB_GRIP : 1);
    const vmax = C.MAX_SPEED * (drs ? C.DRS_BOOST : 1) * (offTrack ? C.GRASS_SPEED : 1);

    // Longitudinal: engine force fades out as we approach vmax.
    if (thr > 0) {
      if (vF < -10) vF += C.BRAKE * thr * dt;
      else {
        const r = vF / vmax;
        vF += C.ACCEL * (drs ? C.DRS_ACCEL : 1) * thr * Math.max(0, 1 - r * r) * dt;
      }
    }
    if (brk > 0) {
      if (vF > 10) vF = Math.max(0, vF - C.BRAKE * brk * dt);
      else vF = Math.max(-C.MAX_REVERSE, vF - C.REVERSE_ACCEL * brk * dt);
    }
    vF -= vF * C.AIR_DRAG * dt;
    if (offTrack) vF -= vF * C.GRASS_DRAG * dt;
    if (thr === 0 && brk === 0) {
      const r = C.ROLL_DRAG * dt;
      vF = Math.abs(vF) <= r ? 0 : vF - Math.sign(vF) * r;
    }

    // Steering: little authority when nearly stopped, less at top speed.
    const sp = Math.abs(vF);
    const steerAuth = Math.min(1, sp / 110) * (1 - 0.4 * Math.min(1, sp / C.MAX_SPEED));
    car.a += (inp.steer || 0) * C.TURN_RATE * steerAuth * (vF < 0 ? -1 : 1) * dt;

    // Re-express velocity relative to the new heading.
    const wx = ca * vF - sa * vS, wy = sa * vF + ca * vS;
    ca = Math.cos(car.a); sa = Math.sin(car.a);
    vF = wx * ca + wy * sa;
    vS = -wx * sa + wy * ca;

    // Lateral grip: cancel sideways motion up to the tyre limit; the rest slides.
    const maxLat = C.GRIP * grip * dt;
    let slip = 0;
    if (Math.abs(vS) <= maxLat) vS = 0;
    else {
      vS -= Math.sign(vS) * maxLat;
      slip = Math.abs(vS);
      vF -= vF * Math.min(1, slip / 400) * 0.6 * dt;   // sliding scrubs speed
    }

    car.vx = ca * vF - sa * vS;
    car.vy = sa * vF + ca * vS;
    car.x += car.vx * dt;
    car.y += car.vy * dt;

    // Tyre wear: distance-based plus extra for sliding.
    const dist = Math.hypot(car.vx, car.vy) * dt;
    car.tyre = Math.max(C.TYRE_MIN, car.tyre - (dist / tr.length) * C.TYRE_WEAR_PER_LAP - slip * dt * C.TYRE_SLIP_WEAR);

    // Walls: keep the car inside the runoff, kill outward velocity, small penalty.
    const nr = nearest(tr, car.x, car.y, car.idx);
    car.idx = nr.idx;
    const lim = tr.halfW + C.RUNOFF - C.CAR_RADIUS;
    let hit = 0;
    if (nr.d > lim) {
      const p = tr.pts[nr.idx];
      const ux = (car.x - p.x) / nr.d, uy = (car.y - p.y) / nr.d;
      car.x = p.x + ux * lim;
      car.y = p.y + uy * lim;
      const vn = car.vx * ux + car.vy * uy;
      if (vn > 0) {
        car.vx -= ux * vn * (1 + C.WALL_BOUNCE);
        car.vy -= uy * vn * (1 + C.WALL_BOUNCE);
        car.vx *= C.WALL_SPEED_KEEP;
        car.vy *= C.WALL_SPEED_KEEP;
        hit = vn;
      }
    }
    car.surface = surf;
    car.slip = slip;
    return hit;
  }

  // Car-to-car bump. Each car is two circles. `shareA`/`shareB` say how much
  // of the push each side applies (0.5 + 0.5 = full equal-mass collision).
  // In multiplayer each machine only moves the car it owns with share 0.5, so
  // both sides together produce one consistent collision.
  function collideCars(a, b, shareA, shareB) {
    const dx0 = a.x - b.x, dy0 = a.y - b.y;
    if (dx0 * dx0 + dy0 * dy0 > 60 * 60) return 0;
    const R = C.CAR_RADIUS, O = C.CAR_CIRCLE_OFFSET;
    const ac = Math.cos(a.a) * O, as = Math.sin(a.a) * O;
    const bc = Math.cos(b.a) * O, bs = Math.sin(b.a) * O;
    let best = null, bestPen = 0;
    for (let i = -1; i <= 1; i += 2) {
      for (let j = -1; j <= 1; j += 2) {
        const dx = (a.x + ac * i) - (b.x + bc * j), dy = (a.y + as * i) - (b.y + bs * j);
        const d = Math.hypot(dx, dy), pen = 2 * R - d;
        if (pen > bestPen) { bestPen = pen; best = d > 1e-3 ? [dx / d, dy / d] : [1, 0]; }
      }
    }
    if (!best) return 0;
    const [nx, ny] = best;
    a.x += nx * bestPen * shareA; a.y += ny * bestPen * shareA;
    b.x -= nx * bestPen * shareB; b.y -= ny * bestPen * shareB;
    const rv = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (rv < 0) {
      const j = -(1 + C.CAR_RESTITUTION) * rv;
      a.vx += nx * j * shareA; a.vy += ny * j * shareA;
      b.vx -= nx * j * shareB; b.vy -= ny * j * shareB;
      return -rv;
    }
    return 0;
  }

  return {
    C, TEAMS, AI_NAMES, TRACK_DEFS,
    clamp, lerp, wrapAngle, lerpAngle, fmtTime,
    buildTrack, gridSlot, inDrsZone, nearest, surfaceOf, stepCar, collideCars
  };
});
