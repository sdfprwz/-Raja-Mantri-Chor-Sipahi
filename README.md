# 👑 Raja Mantri Chor Sipahi — Online Multiplayer

Traditional Indian chit game, now playable online with friends **+ bots**.
No accounts, no database — create a room, share the QR/link, and play.

Live stack: **Node ≥ 18 · Express 4 · Socket.IO 4 · vanilla JS/CSS** (no framework, no build step).

---

## 🎲 Rules

### Classic — 4 players (frozen)
| Chit | Points |
|---|---|
| 👑 Raja | **1000** (fixed) |
| 🎩 Mantri | **800** (fixed) |
| 🕵️ Sipahi | **500** if they catch the Chor, else **0** |
| 🥷 Chor | **0** if caught, else **500** |

Sipahi picks **any other player** as the suspect.

### Darbar Variant — 5 to 7 players
Adds a royal court on top of the classic core:

| Chit | Points |
|---|---|
| 👑 Raja | **1000** (fixed, **publicly revealed**) |
| 🎩 Mantri | **800** (fixed, **publicly revealed**) |
| ⚔️ Senapati | **600** (fixed, hidden suspect) |
| 🛡️ Kotwal | **400** (fixed, hidden suspect) |
| 🧑‍🌾 Praja | **200** (fixed, hidden suspect) |
| 🕵️ Sipahi / 🥷 Chor | same 500/0 duel as classic |

After the peek, **Raja, Mantri & Sipahi are revealed to everyone**.
The Sipahi may only accuse from the **hidden suspects** — Raja/Mantri can never be Chor
(the server rejects anything else with _"Pick a suspect — Raja/Mantri cannot be Chor."_).

### Round flow (both modes)
1. Chits are dealt secretly each round — the deal is **crypto-shuffled** and
   re-rolled (up to 60 tries) so **nobody repeats last round's role** when avoidable.
2. Your chit shows for **7 seconds**, then auto-hides (anti-sneak).
   **👁 Peek** gives one 2-second glance at a time.
3. **Sipahi** must catch the **Chor**:
   - Classic: **30s** timer. Variant: **30s + 5s per hidden suspect beyond 3**
     (e.g. 6P → 4 suspects → 35s).
   - Timeout (or bot Sipahi) → **random auto-guess** after ~3–5s.
4. Correct guess → Sipahi **+500**, Chor **+0**. Wrong guess → swapped (Chor **+500**, Sipahi **+0**).
   All other roles always score face value.
5. Highest total after all rounds wins 🏆 (medal podium for up to 7 players).

---

## ✨ Features

- 🔑 **Rooms** — 4-letter codes (unambiguous alphabet, no `0/O/1/I`) + live **open-room browser**
- 📷 **QR + invite links** — lobby shows a scannable QR + `/?room=CODE` deep link,
  with copy-link, regenerate-QR, and native **Web Share** support. Scanned players land
  on the play slide with the code pre-filled
- 🎭 **Two modes** — Classic 4P frozen, Darbar Variant 5–7P with public reveals
- 🔢 **Rounds 1–500 or ♾️ endless** — host sets at creation, can change in lobby,
  and can **extend/shorten mid-game** (never below the current round) or **🏁 End game** early
- 🤖 **Bots** — host adds/removes in lobby, empty seats **auto-fill on start**,
  bot Sipahi auto-guesses, and **leavers mid-game become bots** (`Name (left)`) so rounds finish
- 👑 **Host migration** — leaving host passes the crown to the next human automatically
- ⏱ **Timers everywhere** — 7s reveal countdown with ticks, guess countdown with urgent ticks
- ⭐ **Live scoreboard**, round reveal animation, result cards with role art, winner podium
- 🔊 **Sound effects** — pure Web Audio (no files): join/leave, round start, ticks,
  your-turn fanfare, correct/wrong jingle, win fanfare. Toggle persisted in `localStorage`
- 💬 **Room chat** — 300 chars/message, last 50 kept per room (in-memory),
  with a game-event feed (joins, catches, winners) + toast + sound alerts and unread badge
- 📱 **Mobile-first + PWA** — responsive layout, installable (`📲 Install`),
  offline page, service worker (`rmcs-v2`)
- 🖼️ **Character art** — hero banner + Raja/Mantri/Chor/Sipahi cards with graceful
  emoji fallback if an asset is missing

---

## 🗂️ Project structure

```
server.js                  # Express + Socket.IO server, all game logic (in-memory rooms)
public/
  index.html               # Home slider, lobby (QR/share), game (chit/guess/result/podium), chat
  client.js                # Socket client, screens, timers, sounds, QR, chat, slider
  style.css                # Dark royal-court theme, animations, responsive layout
  pwa.js                   # Backend-URL resolution, service-worker + install-prompt helpers
  sw.js                    # PWA service worker (rmcs-v2): network-first pages, cache-first assets
  manifest.webmanifest     # PWA manifest (standalone, portrait, icons, screenshot)
  offline.html             # Offline fallback page
  privacy-policy.html      # Privacy policy (linked in footer, needed for store listings)
  assets/                  # hero-group.jpg, raja.jpg, mantari.jpg, chor.jpg, sipahi.jpg
  icons/                   # icon.svg, icon-192/512.png, maskable-512.png, apple-touch-icon.png
  .well-known/             # assetlinks.json (TWA / Play Store) + apple-app-site-association
capacitor.config.json      # Capacitor wrapper (appId com.rajamantri.app, webDir public)
render.yaml                # Render blueprint (free web service, Node 18)
package.json               # scripts: start, cap:* (android/ios), engines node >= 18
```

### Key server notes (`server.js`)
- `rooms: Map<code, room>` — everything is in memory; restarts wipe rooms/chat/scores.
- Room lifecycle: `lobby → reveal → guess → result → (next round | gameover)`, plus
  `restartGame` back to lobby. `clearTimers()` guards every transition.
- Private roles are emitted **only to their owner** (`roundStarted` per socket);
  `roundAnnounce`/`guessPhase`/`roundResult` carry public data only.
- Chat: `pushChat` (trim to 50) → `chatMsg`; `sysMsg` for the feed; `announce`
  additionally emits `playerEvent` (toast + sound even with chat closed).

### Key client notes (`public/client.js`, `pwa.js`)
- Connection: same-origin `io()` on web; when wrapped/installed, `pwa.js` resolves the
  backend from `?server=` → `localStorage rmcs_server_url` → `<meta name="rmcs-server">`.
- All user text (names/chat) goes through `escapeHtml` before DOM injection.
- Timers are client-side mirrors of the server phases (reveal 7s, guess N s) — the
  server is authoritative for scoring and phase changes.

### PWA / mobile notes
- `sw.js` never caches `/socket.io/*` or `/health`. Navigations are
  **network-first** (fallback to cached `index.html` → `offline.html`); static
  assets are **cache-first**.
- `server.js` serves `sw.js` with `Cache-Control: no-cache`, returns **404 for
  missing `/assets/*`** (so `<img onerror>` fallbacks work), and SPA-falls-back
  everything else to `index.html` (supports `?room=` deep links).
- Capacitor: `npm run cap:sync` (or `build:android`/`build:ios`), then
  `cap:open:android|ios`. Fill `public/.well-known/assetlinks.json` at Play publish time.

---

## 🚀 Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 — open 4 tabs (or mix humans + 🤖 bots) to simulate a full room.
Health check: `GET /health` → `{ "ok": true }`.

---

## ☁️ Deploy on Render

1. Push this folder to GitHub.
2. Render → **New → Web Service** → connect the repo
   (or use the `render.yaml` blueprint).
3. Build: `npm install` · Start: `npm start` · Node 18 · free plan works.
4. No database needed — rooms are in-memory.

> Note: in-memory rooms reset on redeploy/restart — fine for casual play.

---

## 🔌 Socket protocol (summary)

Client → server: `createRoom {name, totalRounds, mode, maxPlayers}` ·
`joinRoom {name, roomCode}` · `sendChat {text}` ·
`updateSettings {totalRounds, maxPlayers?}` · `addBot` · `removeBot {botId}` ·
`startGame` · `makeGuess {suspectId}` · `nextRound` · `endGame` · `restartGame` ·
`leaveRoom` · `getRooms` · (built-in `disconnect`).

Server → client: `joined` · `roomUpdate` · `publicRooms` · `roundAnnounce` ·
`roundStarted {myRole, …}` · `guessPhase {suspects, revealed, guessSeconds}` ·
`roundResult {roles, isLastRound}` · `gameOver {winner}` · `roundsUpdated` ·
`chatMsg` · `playerEvent {type, text}` · `errorMsg`.

---

## 🔒 Privacy

Nicknames (≤ 15 chars), scores, roles, and chat live **in server memory only**
(last 50 messages per room) and vanish on restart. No accounts, passwords, email,
location, or ads. See [`public/privacy-policy.html`](public/privacy-policy.html)
(also served at `/privacy-policy.html`).

Made with ❤️ by [sdfprwz](https://github.com/sdfprwz) ·
Raja 1000 · Mantri 800 · Sipahi/Chor 500/0 · Senapati 600 · Kotwal 400 · Praja 200
