# 👑 Raja Mantri Chor Sipahi — Online Multiplayer

Traditional Indian chit game, now playable online with friends + bots.

## Rules
- 4 chits: 👑 **Raja (1000)**, 🎩 **Mantri (800)**, 🕵️ **Sipahi (500/0)**, 🥷 **Chor (0/500)**
- Chits are secret, visible for **7 seconds** then auto-hidden (anti-sneak). Peek button gives 2s glances.
- Sipahi picks a suspect. Correct → Sipahi 500, Chor 0. Wrong → swapped (Chor 500, Sipahi 0).
- Highest total after N rounds wins 🏆.

## Features
- 🔑 Create / join rooms with 4-letter codes + open-room browser
- 🤖 Add bots to fill seats (auto-fill on start, bot Sipahi auto-guesses, leavers become bots)
- 🔢 Host sets 1–10 rounds
- ⏱ Sipahi 30s guess timer with auto-pick on timeout
- ⭐ Live scoreboard, round reveal animation, winner podium
- 💬 Room chat with game-event feed (joins, catches, winners)
- 📱 Mobile responsive

## Run locally
```
npm install
npm start
```
Open http://localhost:3000 — open 4 tabs to simulate 4 players.

## Deploy on Render
1. Push this folder to GitHub.
2. Render → New → Web Service → connect repo.
3. Build: `npm install`, Start: `npm start` (or use `render.yaml` blueprint).
4. Free plan works — no database needed (in-memory rooms).

> Note: in-memory rooms reset on redeploy/restart — fine for casual play.
