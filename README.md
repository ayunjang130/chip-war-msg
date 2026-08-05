# Chip War (MSG v2.0) — real-time prototype

A real-time multiplayer economic strategy game. Teams run chip companies,
invest in Tech/Capacity, set price & quantity live in front of everyone else,
and compete for Apple's purchase orders across 6 rounds.

Stack: **Node.js + Express (static hosting) + Socket.io (real-time sync)**.
State lives in server memory only — no database.

## Run it locally

```
npm install     # first time only
npm start
```

Then open:
- Players: `http://localhost:3000`
- Host dashboard: `http://localhost:3000/host`

## Put it on the internet (one link, works for anyone, anywhere)

`localhost` only works on your own laptop. To get a real `https://...` link
that friends/players anywhere can open, deploy this folder to a free Node.js
host such as **Render** (render.com) — connect this project as a GitHub repo,
create a "Web Service", build command `npm install`, start command
`npm start`. Render (and platforms like it) automatically sets a `PORT`
environment variable, which `server.js` already reads via
`process.env.PORT`, so no code changes are needed.

Free tiers on most platforms spin a server down after ~15 minutes idle and
take ~30–60s to wake back up on the next visit — normal, not a bug. Once
someone's connected, the game itself keeps it awake.

**Do not upload the `node_modules/` folder** — the host installs it for you
from `package.json`. `.gitignore` already excludes it.

## Many independent hosts, many independent rooms — already supported

Every time anyone opens `/host` and clicks "Create room", the server
generates a fresh random 5-character room code and starts a brand new,
fully isolated game state (own teams, own timer, own history). Nothing is
shared between rooms. So any number of hosts around the world can run their
own separate matches on the exact same link at the same time.

A background sweep removes rooms that have sat empty (no host, no players)
for 30+ minutes, so long-running public deployments don't leak memory.

## Feature checklist (maps to the GDD)

- [x] 6-round loop: production → investment → live pricing/negotiation →
      lock-in (with timeout auto-submit) → Apple purchase algorithm → results
- [x] Exact formulas: Price/Tech/Capacity scores, Competitive Score, weighted
      Market Price, division-by-zero guards, Company Value
- [x] Debt allowed (negative capital from investment or poor sales)
- [x] Room codes, lobby, host dashboard (config, pause/resume/force-skip,
      kick, reset), reconnection by teamId (including mid-results/game-over)
- [x] Live "visible bluffing" ticker + negotiation chat channel
- [x] Hidden info: capital is only visible to its own team + the host
- [x] Beginner onboarding: "How to Play" modal (auto-shown once, reopenable
      via the `?` button) + inline plain-language hints on every control
- [x] Optional AI bots (Tech/Capacity/Balanced) for solo/small-group testing
      — a prototype convenience, not in the original design doc
- [x] **Market Shocks** — one random modifier per round (see below)
- [x] **Live purchase-rank preview** — real-time 🟢/🟡/🔴 badge under the
      price box, computed with pure math (no AI, no delay)

## Market Shocks (anti-meta-lock system)

Every round rolls exactly one shock that temporarily changes a rule for
that round only — e.g. "Capacity efficiency -40%" or "Apple weighs Tech 2x
this round." It's built in two layers:

1. **Procedural (always on, free, instant)** — 14 hand-written templates in
   `engine.js` (`getShockTemplates`), each with a randomized magnitude
   rolled fresh every time it's picked, and repeat-avoidance against the
   last 4 rounds' titles. This alone gives real variety with zero setup.
2. **AI (optional, richer)** — if `ANTHROPIC_API_KEY` is set, each round
   `server.js` asks Claude (Haiku) to invent a fresh, situation-aware shock
   instead — it's given the match's current average Tech/Capacity/price and
   a list of recently-used titles, so it can react to whatever strategy is
   dominating instead of repeating a fixed pool.

Every shock, from either source, is passed through
`engine.sanitizeShock()`, which clamps every numeric effect into a safe
range no matter what it received. If the API key is missing, the call
fails, times out (7s cap), or returns something unparseable, the game
silently falls back to the procedural layer — nothing ever blocks or
crashes on this.

**To turn on AI shocks:** get a key at console.anthropic.com (separate,
pay-as-you-go billing from a claude.ai subscription), then add it as an
environment variable named `ANTHROPIC_API_KEY` in your host's dashboard
(Render: your service → **Environment** tab → **Add Environment Variable**).
Cost is small per call (a short Haiku request each round) but real. The
lobby screen on `/host` shows whether it's currently active.

## Live purchase-rank preview

Deliberately **not** AI — it's `engine.computeLivePreview()`, which re-runs
the exact same `resolveApplePurchase()` used for the real result, on
whatever prices/quantities are currently visible (including everyone's
still-being-typed numbers, since those are already public via the ticker).
It updates on every keystroke with zero network latency and is guaranteed
to match what the real end-of-round resolution will do, because both call
sites share the same effective-weights/effective-demand helpers that fold
in the round's active shock.

## What to expand next

1. **Language.** UI is English-only right now. If the audience is genuinely
   global, the highest-leverage next step is a language picker with a small
   translation table (the "How to Play" modal and control labels are the
   ~40 strings that matter most).
2. **Spectator link.** A read-only URL (ticker + timer + leaderboard, no
   controls) would let a teacher project the match on a screen without
   exposing host controls.
3. **Persistence.** Everything lives in memory, so a server restart wipes
   all in-progress games. Fine for a single class period; add Redis or a
   tiny SQLite file if matches need to survive a deploy or crash.
4. **Always-on hosting.** The free tier's cold-start delay is fine for
   casual use; for a scheduled big event, the ~$7/mo "always on" tier on
   most platforms removes it entirely.
5. **Shock history recap.** The final results screen could list all 6
   rounds' shocks in order — a nice debrief tool for a class discussion of
   "what would you do differently."
