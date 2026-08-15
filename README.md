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
      kick, reset, destroy), reconnection by teamId (incl. mid-results/game-over)
- [x] Live "visible bluffing" ticker + moderated negotiation chat channel
- [x] Hidden info: capital is only visible to its own team + the host
- [x] Beginner onboarding: "How to Play" modal + inline plain-language hints
- [x] Optional AI bots (Tech/Capacity/Balanced) for solo/small-group testing
- [x] Market Shocks (procedural + optional AI) + live purchase-rank preview
- [x] Team names shown bold, above the cosmetic company name, everywhere
- [x] Upgrade costs escalate 1.5x per purchase; $5,000 starting budget
- [x] Mid-match joins blocked with a clear message + Exit This Room
- [x] Host: kick (with confirm), Destroy Room, live-editable settings
- [x] Post-match charts (Company Value / Price / Market Price by round) +
      one-click CSV export of the full match
- [x] Price ceiling (3x last Market Price) blocks the "type an absurd
      number" exploit while leaving real premium pricing intact
- [x] Undo a Tech/Capacity purchase from the current round, any time
      before Lock In
- [x] Leave Room available after game_over, not just from the lobby
- [x] Real-time price/quantity changes pop + flash a direction arrow on
      the ticker, not just a generic card highlight
- [x] Market Shock banner redesigned to stand out (glow, entrance
      animation, plain-language "impact" line alongside the flavor text)
- [x] Round-winner celebration (money animation + banner) for whichever
      team earned the most revenue that round
- [x] Default Apple demand per team is 70 (was 200) - deliberately below
      the free production floor (100/round) so scarcity, and therefore
      Competitive Score, is real by default instead of everyone selling out
- [x] Total Apple Demand (demand/team × team count) shown live to BOTH the
      host and every player - no one has to look at the host screen to
      understand how big the market they're competing for actually is
- [x] Player screen decluttered: long always-visible explanation
      paragraphs replaced with small ⓘ tooltips (hover on desktop, tap on
      touch); the buttons and live numbers are what's left on screen
- [x] "How to Play" rewritten as 4 short, complete-sentence steps instead
      of a stack of loosely-related paragraphs
- [x] Up to 4 people can share control of one team/company - the join
      screen shows existing teams with open seats, not just "create new"

## Multi-person teams (up to 4 people per company)

A "team" is no longer one device. `room.teams[id].members` is an array
(max `engine.CONFIG.MAX_MEMBERS_PER_TEAM`, 4) of
`{ memberId, socketId, memberName, connected }`. All game-affecting actions
(`UPDATE_INPUT`, `TEAM_INVEST`, `TEAM_UNDO_INVEST`, `LOCK_IN`) still target
one shared team object - any connected member can act, last-action-wins,
exactly like a group chat where anyone can type. Capital visibility is
still per-*team* (all of a team's members see their own team's capital;
no other team does), unaffected by how many people are behind it.

Joining flow: entering a room code triggers a read-only `LOOKUP_ROOM` call
that lists teams with open seats (bots excluded - joining a bot doesn't
make sense). Picking one calls `JOIN_ROOM` with that `teamId` but no
`memberId`, which the server treats as "seat this new person on an
existing team" - allowed at *any* match phase, since adding a hand to an
already-playing company doesn't touch production/investment history the
way spawning a brand-new team mid-match would (that path is still
lobby-only). Each browser stores its own `{roomCode, teamId, memberId}` in
localStorage, so reconnecting (page reload, dropped wifi) restores that
specific person's seat rather than looking like a new join.

## Total Apple Demand — visible without the host screen

Every `STATE_SYNC` a player receives now includes `demandPerTeam` (this
round's effective per-team demand, already adjusted for any active shock)
and `totalDemand` (that x the number of teams). The player round-header
shows it directly, with a tooltip explaining the mechanic in one sentence -
so reasoning about "how much can I realistically sell" no longer requires
peeking at `/host`. The host's lobby and live-monitor screens show the
same number, computed the same way, so host and players are always looking
at consistent figures.

## Price ceiling — the anti-exploit fix

The purchase algorithm ranks sellers by score, but when total supply is
*below* total demand, every team's full offer sells regardless of rank -
so a price of $999,999 used to be pure free money as long as nobody
undercut total demand. `engine.calcMaxPrice()` now caps every submitted
price at `PRICE_CEILING_MULTIPLIER` (3x, in `engine.js`) times the last
resolved round's Market Price (or $50 before round 1 has one). The server
clamps this on every keystroke (`UPDATE_INPUT`) and again defensively at
resolution time, so it can't be bypassed from a modified client either.
3x still leaves real room for a genuine "raise the price, take the margin
hit on volume" strategy - it only blocks the absurd end of the range.

## Undo (this round only)

Each team's `roundStartTechLevel`/`roundStartCapacityLevel` are snapshotted
the moment a round starts, and every purchase made during the round is
pushed onto a small per-team ledger with its exact cost. `TEAM_UNDO_INVEST`
pops the last entry, refunds it, and drops the level by one - but only
down to that round's starting level, and only before Lock In. Anything
from a previous round is already permanent and cannot be undone.

## Round timer / demand / market volatility now apply live

Previously, changing "Apple demand per team" or "Round timer" only took
effect if saved while still in the lobby - there was no way to touch them
once a match started. `HOST_UPDATE_CONFIG` now applies those two fields
(plus the new Market Volatility dial) immediately, at any phase, and the
host's live-monitor screen has its own small "Live-adjustable settings"
panel so there's actually a control to reach them mid-match. Everything
else (scoring weights, max teams, Starting Budget, inflation rate) stays
lobby-only, since changing those mid-match wouldn't make sense retroactively.

## Advanced Settings — how the vaguer asks got mapped to concrete controls

Three requested "difficulty knobs" (inflation, consumer price sensitivity,
advertising efficiency) were specified only by name, not by formula. Rather
than inventing three loosely-defined new systems, they were mapped to:

- **Inflation rate per round** — a real new field. Compounds onto every
  Tech/Capacity upgrade's base cost each round (on top of the existing
  1.5x-per-purchase curve).
- **Consumer price sensitivity** — this is just the existing **Price
  weight (Wp)** slider. Turning it up makes price matter more in Apple's
  purchase decision; no new field needed.
- **Advertising efficiency / external-variable difficulty** — folded into
  the new **Market Volatility** dial (0.5x-2.0x), which scales how far
  *every* Market Shock swings away from neutral each round. This is the
  cleanest single proxy for "how harsh are external forces this match"
  without adding an unbalanced fourth stat for players to chase.

"Market size" wasn't added as a separate field either - it's already the
product of **Apple demand per team × number of teams (Max teams)**, both
of which were already configurable.

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
in the round's active shock (and now Market Volatility too).

## Basic profanity filter

`engine.containsProfanity()` is a plain word-list check (whole-word match
on normalized text, so "class" never matches "ass"). A blocked message
never reaches the chat log or other players — the sender gets a private
"Message blocked" notice instead. It's intentionally simple: easy to
bypass with creative spelling, good enough for the common case. Swap in a
real moderation API later if stronger coverage matters.

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
5. **Stronger moderation.** The profanity filter is a basic word list, not
   an NLP system — fine for a classroom, but a real moderation API would
   close the "creative misspelling" gap if this ever goes fully public.
