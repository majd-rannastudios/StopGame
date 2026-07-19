# ⛔ STOP! — real-time multiplayer letter race

The classic **STOP / Categories / Le Petit Bac / لعبة الاسم** game, built as a production-grade
real-time multiplayer web app. A server-authoritative wheel picks the letter, everyone races to
fill categories, the first player slams **STOP**, answers reveal with unique/duplicate scoring,
peers can challenge, best total wins.

**Languages:** English · Français · العربية (full RTL, Arabic letter wheel)
**Tested:** shared engine self-test + a headless 3-player end-to-end match (`tools/e2e.mjs`) both pass.

---

## Quick start (2 terminals)

```bash
npm install
npm run build:shared          # compile the shared rules engine once

# terminal 1 — game server (Colyseus, port 2567)
npm run build:server && node server/dist/index.js

# terminal 2 — web client (Vite, port 5173)
npm run dev:web
```

Open `http://localhost:5173` in **two browser windows**, create a room in one, join with the
code in the other, press Start. To test on your phone over LAN, open `http://<your-ip>:5173` —
the client auto-targets `ws://<host>:2567`.

Run the automated 3-player match:

```bash
node server/dist/index.js &   # if not already running
node tools/e2e.mjs            # → "E2E: ALL PASS ✅"
```

---

## Repo map

```
packages/shared/    THE RULES ENGINE (single source of truth, unit-tested)
  ruleset.ts          every tunable lives on one Ruleset object — nothing hard-coded
  letters.ts          letter pools per language/difficulty (arcs === true probability)
  normalize.ts        matching normalization: diacritics, Arabic orthography, plural folding
  scoring.ts          unique/dup/invalid scoring, false-STOP penalty, challenge re-score
  events.ts           the wire protocol (C2S intents / S2C broadcasts)
  __selftest__.ts     assertions for normalization + scoring (node dist/__selftest__.js)

server/             AUTHORITATIVE GAME SERVER (Colyseus + Express)
  rng.ts              CSPRNG letter bag, commit–reveal hashes, room codes (no 0/O/1/I)
  rooms/MatchRoom.ts  the state machine: LOBBY→COUNTDOWN→SPINNING→WRITING→STOP_GRACE→
                      LOCKED→REVEAL(→challenges)→SCORED→…→MATCH_END
  state/MatchState.ts synced schema — public-safe data only (answers stay private till lock)
  validation/         layer 0 structural → layer 1 wordlists → layer 2 batched AI (budget-capped)
  wordlists/          seed gazetteers en/fr/ar × 6 categories (expand freely)
  index.ts            /health, /api/resolve/:code, /api/quickmatch + WS transport

apps/web/           CLIENT (Vite + React, mobile-first, RTL-first)
  components/Wheel    deterministic seeded spin, WebAudio ratchet, reduced-motion path
  App.tsx             all screens: home, lobby, spin, play grid + STOP octagon + grace
                      overlay, staged reveal + challenge votes, scoreboard, podium
  i18n.ts / styles.css  trilingual strings + the "stop-sign arcade" design system

supabase/schema.sql  durable layer: matches now; profiles/ratings/friends ready for Phase 2
tools/e2e.mjs        headless 3-client full-match test
Dockerfile           server container (build context = repo root) for Railway/Fly
```

---

## How fairness & security work

- **The client never decides anything.** The letter is drawn server-side with `crypto.randomInt`
  *before* the wheel animates; clients receive `{letter, spinSeed, rotations}` and all render the
  identical landing. Timing (round deadline, STOP grace, lock) runs on server timers — a client's
  clock or a stalled tab can never affect the round.
- **Provably fair.** Before each spin the server broadcasts `sha256(letter+nonce)`; after the
  round it reveals the nonce. The client verifies in-browser (`✓ verified fair` badge). Confirmed
  by the E2E test.
- **Answers are invisible until lock.** Opponents only receive your fill-count during the round;
  raw words live in a server-private buffer and are broadcast simultaneously at reveal — nothing
  to scrape mid-round.
- **Input hardening.** Per-client token-bucket rate limiting on every intent, payload sanitization
  (control chars stripped, length caps), answer fields disable autocomplete/autocorrect, illegal
  phase transitions rejected, one warning-free crash guard around every handler.
- **HTTP surface.** CORS pinned via `CORS_ORIGIN`, `x-powered-by` off, nosniff + no-referrer
  headers, 16 kB JSON body cap. Supabase writes use the **service key on the server only**; RLS is
  default-deny — clients can never write scores or ratings.
- **Validation is honest.** Deterministic layers (structure + wordlists) settle most answers
  instantly; unknowns go to one **batched** Anthropic call hard-capped at 1.5 s so the reveal
  never blocks; anything still uncertain is accepted and left to **peer challenge** (majority
  vote, ties discard the accused's vote — the classic rule).

---

## Configuration

Everything gameplay lives on `Ruleset` (`packages/shared/src/ruleset.ts`): points (10/5/0),
grace seconds, round count, letter pools, STOP eligibility (`stopRequiresAllFilled` — set
`ranked: true` at room creation for the authentic "stop with blanks, get punished" mode),
challenge limits, reconnect grace (45 s, answers restored on rejoin), timers. Server env is in
`server/.env.example` — the AI validator and Supabase persistence are both optional and the game
runs fully without them.

## Deploy

- **Server → Railway:** new service from this repo, Dockerfile at root, expose 2567, set
  `CORS_ORIGIN` + optional `ANTHROPIC_API_KEY`/`SUPABASE_*`. Single instance is fine to start;
  add Redis + Colyseus presence driver when you scale horizontally.
- **Web → any static host** (Railway static/Vercel/Netlify): `npm run build:web`, serve
  `apps/web/dist`, set `VITE_WS_URL=wss://<server>` and `VITE_API_URL=https://<server>`.
- **Supabase:** run `supabase/schema.sql` in the SQL editor; add the URL + service key to the
  server env to turn on match persistence.

## Roadmap hooks already in place

Phase 2 (auth, friends, OpenSkill MMR, leaderboards) has its tables + RLS shipped in
`schema.sql`; quick-match currently fills by language and is ready to key on rating buckets.
Phase 3 (AI opponents, category packs, daily seed, tournaments) slots into `MatchRoom` — AI
players are just seats where the server writes into the same private answer buffer. The full
product spec lives in `CLAUDE_CODE_STOP_GAME_BUILD_v1.md`.
