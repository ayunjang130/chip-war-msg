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
- [x] Live "visible bluffing" ticker + moderated negotiation channel, split
      into a private per-team channel and a leader-only All-Teams channel
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
- [x] Up to 4 people can share control of one team - the join screen shows
      existing teams with open seats, not just "create new"
- [x] Leave Game is available on every screen, including mid-match, and
      goes through the custom confirm modal (not a browser popup)
- [x] Every confirm/destructive action (Leave, Kick, Destroy Room, Lock In
      with $0 price/qty) uses one shared in-app confirm modal - no native
      `confirm()`/`alert()` anywhere in the app
- [x] Cosmetic company names (Samsung/Intel/etc.) are gone from the player
      join flow entirely - a team has exactly one name, which its creator
      picks. Those identities now exist ONLY as bot display names
      (NVIDIA-Bot, TSMC-Bot, Samsung-Bot)
- [x] Join flow is a 4-step wizard (room code → choose create-or-join →
      the one relevant form) instead of one screen showing everything at
      once, each step with a Back button
- [x] No emoji anywhere in the UI - a small hand-authored SVG icon set
      (`public/js/icons.js`) replaces every place an emoji or bare colored
      dot used to stand in: lock status, Tech/Capacity labels, the round
      header stats, BOT badges, the confirm-modal warning, and each Market
      Shock's category tag
- [x] Negotiation is two channels, not one: a private per-team channel
      (any teammate can post) and an All-Teams channel every team can read
      but only each team's current leader can post in - leadership is
      automatic (whoever's connected earliest on the roster) and hands off
      the instant that person disconnects, no manual assignment needed
- [x] Every locked-in offer, Tech/Capacity purchase, and undo auto-posts a
      one-line "who did what" entry into the All-Teams channel - a
      PUBG-style kill feed for the whole match, bots included
- [x] Ticker cards now flash on a Tech/Capacity level change too (not just
      Price/Qty), plus a gold pulse ring the instant a team locks in - the
      same "just happened" ping now covers nearly every action, not only
      typing
- [x] Undo (Tech/Capacity) redesigned from a barely-visible ghost link into
      a bordered, icon-labeled button grouped tightly with Buy
- [x] Market Shock copy rewritten end-to-end (procedural templates + the
      AI prompt) into one plain cause-and-effect sentence - "a key supplier
      just went dark, so every team makes 40% fewer chips this round" -
      with an explicit banned-jargon list (no "multiplier", "elasticity",
      "weight", etc.) so a reader with zero economics background gets it
      in one pass
- [x] Synthesized sound (Web Audio oscillators, no audio files) + physical
      "juice" feedback (button squish, particle bursts, screen-shake
      reserved for rare moments, numbers that roll instead of snap) wired
      into Buy/Undo/Lock In/chat/tab-switching/Market Shock/round results/
      victory - with a persistent, always-visible mute toggle

## Team names replace "team name + cosmetic company name"

`companyName` is gone from the data model entirely - `team.teamName` is
now the only identity a team has, chosen once by whoever creates it via
`JOIN_ROOM`. Every place that used to show `"CompanyName (teamName)"` now
shows just the team name. Duplicate-name protection (append " 2", " 3", …)
now keys off `teamName` instead. Bots are the one exception: they still
get named from the chip-company list (`NVIDIA-Bot`, `TSMC-Bot`,
`Samsung-Bot`) since that's the one place the flavor still fits, and bots
were never going through the player join flow anyway.

## Custom confirm modal (no native browser popups)

`showConfirm(title, message, confirmLabel, onConfirm, opts)` in both
`player.js` and `host.js` renders a small red-accented in-app modal instead
of calling `confirm()`/`alert()`. `opts.noCancel` turns it into a plain
notice (used for "room closed" / "you were kicked"); `opts.neutral` swaps
the red accent for gold on those non-destructive notices. Every
irreversible action in the app - Leave Game, Kick, Destroy Room, and
locking in at $0 - routes through this one component.

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
already-playing team doesn't touch production/investment history the way
spawning a brand-new team mid-match would (that path is still lobby-only).
Leaving (`LEAVE_ROOM`) is now also allowed at any phase for the same
reason - it only ever removes one member's seat, never deletes a team's
game state once a match has started, so history/CSV/leaderboard stay
consistent even if a team ends up with zero connected members mid-match.
Each browser stores its own `{roomCode, teamId, memberId}` in localStorage,
so reconnecting (page reload, dropped wifi) restores that specific
person's seat rather than looking like a new join.

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

## Icon system (`public/js/icons.js`)

A single dependency-free file: a plain `Icons` global holding ~18 small
hand-authored `<svg>` strings (lock, unlock, undo, cpu, layers, users,
grid, crown, star, alert-triangle, bot, send, plus, dollar, package,
target, trending, clock), each using `stroke="currentColor"` so it always
inherits whatever text color it's dropped into — a badge, a button, a
ticker row — with zero extra wiring. Loaded once via a `<script>` tag on
both `index.html` and `host.html` before their respective `player.js` /
`host.js`, since this project has no bundler. Static markup gets an icon
via `<span class="icon-slot" data-icon="cpu"></span>` plus a one-time
`injectIcons()` call at startup; anything built dynamically in JS (ticker
cards, chat rows, the leaderboard) just concatenates `Icons.xxx` directly
into its template string. Kept entirely separate from `engine.js`'s data
model — a shock's `categoryTag` still drives its icon by lookup on the
client, so the "no emoji, ever" guarantee `_engine.test.js` checks for
stays true at the data layer, not just visually.

## Two negotiation channels + team leader

`CHAT_MESSAGE` now takes a `channel: 'team' | 'global'` field instead of
always broadcasting room-wide:

- **Team channel** — `team.chatLog`, private to that team. Any connected
  member can post; only that team's own sockets ever receive it.
- **All-Teams channel** — `room.globalChatLog`, visible to every team +
  host. Only that team's current **leader** can post as them (HOST can
  always post). Reading is unrestricted — every teammate sees it, not
  just the leader.

There's no stored/assignable "leader" field. `getTeamLeader(team)` just
returns whichever member is connected earliest in the roster (falling
back to the first member at all if nobody's connected), computed fresh
every time it's needed. That means leadership silently hands off the
moment the current leader disconnects, instead of a classroom's cross-team
negotiation going silent because the one person who could speak for a
team stepped away.

**Deliberate security note:** a member's `isLeader` status is exposed to
everyone as a boolean (safe — it's not a secret). The raw `memberId` is
**not** — `JOIN_ROOM` reconnection trusts `{roomCode, teamId, memberId}`
alone with no separate token, so if `memberId` ever leaked to other
clients it would let anyone hijack another player's seat. `amILeader`
(used to gate the composer's own input) is computed server-side per
socket inside `broadcastState`'s existing per-member fan-out and injected
into each connected member's own `STATE_SYNC` payload — never derived
client-side from an ID.

New joins/reconnects get caught up via a `CHAT_SYNC` emit (`{team,
global}` history arrays) right after `JOIN_ROOM`/`HOST_REJOIN` succeeds,
so switching to a channel you haven't looked at yet mid-match doesn't
show a blank log. `HOST_RESET_GAME` clears both logs along with the rest
of the match state.

## Activity feed (kill feed)

Every voluntary Lock In, Tech/Capacity purchase, and undo now also posts
a short system-generated line into the All-Teams channel via
`postActivity()` — "Team Alpha upgraded Tech to Lv2", "Team Beta locked
in — $42 × 80 units" — styled visually distinct from human chat (dim,
monospace, a small icon matching the action). Bots go through the exact
same call, so a match run with AI opponents still has a live feed instead
of a suspiciously quiet channel. Deliberately **not** logged: the
continuous per-keystroke price/quantity typing already has its own
real-time signal (the ticker's flash-on-change), so mirroring every
keystroke into the feed as well would just be noise; only the discrete,
"something just became final" actions post. Auto-submitted stragglers at
round timeout are skipped too — by the time that fires, results are about
to render anyway, so a feed entry has nothing left to react to.

## Plain-language Market Shocks

Every shock's `description` — procedural templates and the AI prompt
alike — now follows one fixed shape: a real-world-sounding cause, then
"so `<plain consequence>`", using only Price/Tech/Capacity/Apple/chips as
game vocabulary. "A key supplier just went dark, so every team makes 40%
fewer chips this round" reads the same to someone who's never taken an
economics class as to someone who has. The AI prompt (`SHOCK_SCHEMA_HINT`
in `server.js`) spells out that same shape plus an explicit banned-word
list (multiplier, elasticity, margin, valuation, efficiency, capex,
weight) so AI-generated shocks can't drift back into finance-report tone.
The numeric summary line (`engine.summarizeShockImpact()`) got the same
treatment — "Price weight +65%" is now "Price matters +65%" — while the
host-only raw multiplier view (`host.js`'s `summarizeEffects()`) keeps
its precise `×1.65`-style notation on purpose, since that one's written
for the teacher running the match, not a 15-year-old reading it once.

## Sound + physical feedback ("juice")

Two small, dependency-free modules loaded before `player.js`/`host.js`:

- **`public/js/sound.js`** — every effect is a synthesized oscillator +
  envelope (`tone(freq, duration, opts)`), not an audio file. No asset to
  host, no CDN, works offline once the page is loaded. 9 effects (`click`,
  `tick`, `buy`, `undo`, `error`, `lockIn`, `shock`, `results`, `victory`),
  each 1-4 `tone()` calls. Respects the browser autoplay policy by lazily
  creating/resuming the `AudioContext` on the page's first `pointerdown`/
  `keydown`. On/off state persists via `localStorage` (this app already
  uses it for reconnection, so it's not a new pattern) and is exposed via
  a fixed mute button (top-right, every screen, `z-index:45` - deliberately
  *below* modals/celebration so those still cover it rather than floating
  on top of a confirm dialog).
- **`public/js/juice.js`** — `squish()`/`shake()`/`flashLevelUp()` (CSS
  class retrigger, remove+reflow+re-add so repeated calls actually restart
  the animation), `countUp()` (ease-out number roll instead of an instant
  snap), `burst()` (a handful of DOM dots flying out from an element and
  fading - the same shape as the existing money-rain celebration,
  generalized to fire from any button).

Wired into: Buy/Undo Tech+Capacity (sound + squish + burst on Buy), Lock In
(sound + squish + a bigger burst - the single most significant click in a
round), sending chat (a deliberately quiet tick, since this fires often),
switching negotiation-channel tabs, a blocked chat attempt, a new Market
Shock landing at round start (sound + a shake on the banner - `shake()` is
saved for genuinely rare/big moments on purpose, not routine actions, so it
still reads as "something happened" when it fires), round results
appearing, and both the round-winner celebration and the final game-over
banner (a real fanfare if your own team won, a calmer tone otherwise, so a
losing team doesn't get an oddly triumphant sting on their loss).

Deliberately not in this pass (needs new server-side state, better done as
its own follow-up): a bottom-up dramatic reveal for the results table,
near-miss ("you missed 1st by 3 points") callouts, and streak/comeback
badges.

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
6. **Results-reveal choreography, near-miss callouts, streaks/comebacks.**
   See "Sound + physical feedback" above - the juice layer's hooks are
   already in place, these three need new server-side computation first.
