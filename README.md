# Velocity GP 🏁

### ▶ Play now: **<https://f1-2d-game-production.up.railway.app>**

A top-down, Formula-style racing game for the browser with **online and LAN multiplayer**. Open the link above, create a room and send friends the 4-letter code, or run the server on your own computer and race with everyone on your Wi-Fi. Works on laptops and phones.

- 3-lap races (1–10 configurable), up to 8 cars, AI drivers fill empty grid slots (optional)
- Two fictional circuits: **Aurora Park** and **Kestrel Bay**
- DRS, tyre wear, skid marks, off-track dust, engine sound, mini-map, timing tower
- Server-authoritative lap counting, synchronised five-red-lights start, automatic reconnect

All teams, drivers and circuits are fictional.

---

## Play online (no install)

1. Open **<https://f1-2d-game-production.up.railway.app>**.
2. Enter a name → **Single Player** to race the AI, or **Create Room** to get a 4-letter code.
3. Friends open the same link → **Join Room** → type the code (or tap the room in *Open rooms*).
4. Everyone picks a team colour and presses **Ready up**, then the host presses **Start Race**.

Health check: <https://f1-2d-game-production.up.railway.app/health>

---

## Play on your Wi-Fi (run it yourself)

Use this for the lowest lag when everyone is in the same place, or to play without internet.

## 1. Setup (host computer — do this once)

1. **Install Node.js** (version 16 or newer; the LTS version is recommended) from <https://nodejs.org>.
   Check it worked by opening a terminal and running:
   ```
   node -v
   ```
2. **Open a terminal in this folder** (the one containing `package.json`).
   - Windows: open the folder in File Explorer, click the address bar, type `cmd`, press Enter.
   - Mac: right-click the folder in Finder → *New Terminal at Folder* (or `cd` into it).
   - Linux: `cd /path/to/this/folder`
3. **Install dependencies:**
   ```
   npm install
   ```

## 2. Start the server

```
npm start
```

You'll see something like:

```
  🏁  Velocity GP server is running

  On this computer:          http://localhost:3000
  Players on your Wi-Fi can join at http://192.168.1.5:3000
```

Open `http://localhost:3000` on the host computer. Give the **"Players on your Wi-Fi can join at …"** address to everyone else.

To use a different port: `PORT=4000 npm start` (Mac/Linux) or `set PORT=4000 && npm start` (Windows Command Prompt).
Stop the server with **Ctrl + C**.

## 3. Find the host's local IP address (if you need it manually)

The server prints it on startup, but you can also look it up:

| OS | How |
|---|---|
| **Windows** | Open Command Prompt and run `ipconfig`. Look for **IPv4 Address** under your Wi-Fi adapter (e.g. `192.168.1.5`). |
| **Mac** | System Settings → Wi-Fi → *Details…* next to your network → **IP address**. Or in Terminal: `ipconfig getifaddr en0` |
| **Linux** | Run `hostname -I` (first address) or `ip addr show` and look for `inet 192.168.x.x` on your Wi-Fi interface (often `wlan0`/`wlp…`). |

The address usually starts with `192.168.`, `10.` or `172.16–31.`.

## 4. Allow the port through the firewall

Other devices must be able to reach port **3000** on the host.

- **Windows:** the first time you run `npm start`, Windows Defender Firewall asks whether to allow Node.js — tick **Private networks** and click *Allow*. If you missed it: *Windows Security → Firewall & network protection → Allow an app through firewall → Node.js → Private* ✔. Make sure your Wi-Fi is set to a **Private** network (not Public).
- **Mac:** if asked *"Do you want the application node to accept incoming network connections?"*, click **Allow**. (System Settings → Network → Firewall → Options to change it later.)
- **Linux:** if you use `ufw`: `sudo ufw allow 3000/tcp`.

Also note: some guest/public/office Wi-Fi networks block devices from talking to each other ("client isolation"). A home network or a phone hotspot works best.

## 5. How other players join

1. Connect to the **same Wi-Fi** as the host.
2. Open a browser (Chrome, Edge, Firefox or Safari — phones too) and go to the host's address, e.g. `http://192.168.1.5:3000`.
3. Enter a name → **Join Room** → type the 4-letter code (e.g. `K7QX`) or tap the room in the *Open rooms* list.
4. Pick a team colour and press **Ready up**. When everyone's ready, the host presses **Start Race**.

## 6. Deploy your own copy (Railway or Render)

The official copy runs on Railway at <https://f1-2d-game-production.up.railway.app>. To deploy your own, push this folder to a GitHub repository first, then:

**Render** (<https://render.com>)
1. *New → Web Service* → connect your GitHub repo.
2. Runtime: **Node**. Build command: `npm install`. Start command: `npm start`.
3. (Optional) Health check path: `/health`.
4. Create the service. When it's live, open the `https://<name>.onrender.com` address and share it.

**Railway** (<https://railway.app>)
1. *New Project → Deploy from GitHub repo* → pick the repo. Railway detects Node and runs `npm start`.
2. In the service's *Settings → Networking*, click **Generate Domain**.
3. (Optional) *Settings → Deploy → Healthcheck Path*: `/health`.
4. (Optional) *Variables* → add `PUBLIC_URL` = your `https://<name>.up.railway.app` address, so the server's startup log shows it.
5. Open the `https://<name>.up.railway.app` address and share it. Every push to GitHub redeploys it automatically.

Nothing needs configuring: the server reads the port from `PORT`, the page connects its WebSocket back to whichever address it was loaded from (`wss://` on https, `ws://` on http), and the lobby shows the public address instead of a Wi-Fi one. On any other host, set a `PUBLIC_URL` environment variable so the lobby shows the right link.

Notes:
- Online play adds internet latency (typically 30–150 ms vs. a few ms on Wi-Fi). Other cars are interpolated, so it stays smooth, but bumps between cars feel softer.
- Rooms live in memory, so a restart or redeploy ends any race in progress.
- Render's free tier sleeps after ~15 minutes without visitors; the first visit then takes up to a minute to wake it.
- `GET /health` returns `{"status":"ok", ...}` with uptime and room/player counts.

---

## Playing

### Main menu
- **Single Player** — you vs AI drivers. Can be paused.
- **Create Room** — you become the host and get a 4-character room code. You choose the track, number of laps, AI difficulty and whether AI cars fill the grid.
- **Join Room** — enter a code or pick an open room from the list.

### Controls

| Action | Keyboard | Touch (phones/tablets) |
|---|---|---|
| Accelerate | `↑` or `W` | **GAS** |
| Brake / reverse | `↓` or `S` | **BRAKE** |
| Steer | `←` `→` or `A` `D` | **◀ ▶** |
| DRS boost | `Space` | **DRS** |
| Pause (single player) / menu (multiplayer) | `P` or `Esc` | ☰ button |
| Reset car onto the track | `R` | — |
| Mute / unmute | `M` | 🔊 button |

On phones, landscape orientation is recommended.

### Racing rules
- **Laps only count** if you pass every checkpoint around the lap in order — no shortcuts.
- **DRS**: only in the DRS zone on the main straight (marked "DRS" on the track), once per lap, ~2.8 s of extra top speed. Braking closes it.
- **Tyres** wear down a little every lap (more if you slide), slowly reducing grip. Tyre health is shown bottom-right.
- **Grass** slows you heavily; **walls** stop you with a small speed penalty; cars **bump** each other.
- After the winner finishes, everyone else has 40 seconds to cross the line. Then everyone returns to the lobby with the results, and the host can start another race.
- Your personal best lap for each track is saved in your browser.

### Rooms & connection
- Up to 8 players per room; each team colour can only be used once.
- If the host leaves, host control passes to the next player.
- If your connection drops, you'll see *"Connection lost, reconnecting…"* and the game rejoins automatically. In multiplayer, an AI drives your car while you're away (it doesn't count toward your PB); in single player the race pauses. Your slot is kept for 20 seconds.

---

## Project structure

```
server.js           Node server: Express static hosting, /health, WebSocket rooms, race control, AI
public/index.html   The game client (HTML + CSS + JS, HTML5 Canvas, Web Audio)
public/shared.js    Shared by server AND client: constants, track data, physics, collisions
package.json        Dependencies (express, ws) and the "start" script
```

### How the networking works
- Messages are JSON over one WebSocket (`/ws`), each with a `type` field — e.g. `createRoom`, `joinRoom`, `roomList`, `lobbyUpdate`, `ready`, `startRace`, `raceInit`, `lights`, `go`, `carState`, `raceUpdate`, `lapCompleted`, `carFinished`, `raceFinished`, `playerLeft`, `rejoin`, `ping`/`pong`.
- Each client simulates **its own car** locally for instant response and sends its state ~20×/s (`carState`).
- The server runs at a fixed 60 ticks/s. It owns the race clock, checkpoints, laps, positions and results, simulates the **AI cars**, sanity-checks player movement (impossible jumps are rejected), and broadcasts every car ~20×/s (`raceUpdate`).
- Clients draw other cars **100 ms in the past**, interpolating between snapshots so motion stays smooth.
- The start is synchronised: the server sends the five lights one by one and then `go` after a random hold.
- Dead connections are cleaned up two ways: a WebSocket ping/pong heartbeat every 25 s, and any client that stops answering the 2 s app-level `ping` for 10 s is dropped (so an AI takes over its car quickly).

## Troubleshooting
- **Online: "Connection lost, reconnecting…" right after a deploy:** the server restarted. The page reconnects on its own; rooms from before the restart are gone, so create a new one.
- **Other devices can't load the page:** check they're on the same Wi-Fi, the address includes `:3000`, and the firewall allows Node.js (section 4). Try opening the address on the host computer itself first.
- **"Port 3000 is already in use":** another program is using it — close it or start with `PORT=3001 npm start`.
- **No sound:** browsers only allow audio after you click or press a key; also check the 🔊 button / `M`.
