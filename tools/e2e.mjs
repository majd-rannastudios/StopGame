/**
 * Headless E2E: 3 clients play a full 2-round match against a live server.
 *
 * Covers: room codes, join-by-code, one identical server letter on all clients,
 * answer flow, STOP + grace, duplicate/unique scoring, commit-reveal fairness,
 * the table-vote review queue, the everyone-must-be-ready round gate, that round
 * points are banked exactly once, and final standings.
 *
 * Answers are drawn from the server's own wordlist, so the deterministic layer
 * settles every one of them and the run needs no API key and costs nothing.
 *
 *   node tools/e2e.mjs
 */
import { Client } from "colyseus.js";
import { createHash } from "crypto";
import { readFileSync } from "fs";

const WS = process.env.E2E_WS || "ws://localhost:2567";
const API = process.env.E2E_API || "http://localhost:2567";
const CATS = ["name", "place", "animal", "food", "object", "celebrity"];
const WORDS = JSON.parse(readFileSync(new URL("../server/src/wordlists/en.json", import.meta.url)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => { console.error("\nE2E FAIL:", m); process.exit(1); };
const ok = (m) => console.log("  ✓", m);

async function waitFor(pred, label, ms = 40_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = pred();
    if (v) return v;
    await sleep(120);
  }
  die(`timed out waiting for ${label} (${ms}ms)`);
}

/** Two real words per category for this letter: one shared, one unique. */
function pickWords(letter) {
  const L = letter.toLowerCase();
  const out = {};
  for (const c of CATS) {
    const hits = WORDS[c].filter((w) => w.toLowerCase().startsWith(L));
    if (hits.length < 2) die(`wordlist too thin: ${c} has ${hits.length} word(s) for "${letter}"`);
    out[c] = { shared: hits[0], solo: hits[1] };
  }
  return out;
}

/* ---------------- connect ---------------- */

const clients = { A: new Client(WS), B: new Client(WS), C: new Client(WS) };
const spins = {}, reveals = {}, ends = {}, reviews = {}, toasts = {};
function wire(tag, room) {
  room.onMessage("spin", (p) => (spins[tag] = p));
  room.onMessage("reveal", (p) => (reveals[tag] = p));
  room.onMessage("matchEnd", (p) => (ends[tag] = p));
  room.onMessage("reviewResult", (p) => ((reviews[tag] ??= []).push(p)));
  room.onMessage("toast", (p) => ((toasts[tag] ??= []).push(p.key)));
  room.onMessage("restore", () => {});
  room.onError(() => {});
}

console.log("\n── setup ───────────────────────────────");
const roomA = await clients.A.create("match", {
  name: "Alice", lang: "en", rounds: 2, roundSeconds: 40, difficulty: "easy", private: true,
});
wire("A", roomA);
await sleep(400);

const code = roomA.state.roomCode;
if (!/^[A-Z2-9]{6}$/.test(code)) die("bad room code: " + code);
ok(`room code ${code}`);

const res = await fetch(`${API}/api/resolve/${code}`);
if (!res.ok) die("code did not resolve to a room");
const { roomId } = await res.json();
const roomB = await clients.B.joinById(roomId, { name: "Bilal" }); wire("B", roomB);
const roomC = await clients.C.joinById(roomId, { name: "Carla" }); wire("C", roomC);
await sleep(500);
if (roomA.state.players.size !== 3) die("expected 3 players, got " + roomA.state.players.size);
ok("3 players joined by code");

const pids = { A: roomA.sessionId, B: roomB.sessionId, C: roomC.sessionId };
const rooms = { A: roomA, B: roomB, C: roomC };

/* ---------------- a round ---------------- */

async function playRound(n) {
  console.log(`\n── round ${n} ──────────────────────────────`);
  if (n === 1) roomA.send("start"); // host-only gate
  await waitFor(() => roomA.state.phase === "WRITING", `round ${n} WRITING`);

  const L = roomA.state.letter;
  if (!L) die("no letter in state");
  if (spins.A?.letter !== L || spins.B?.letter !== L || spins.C?.letter !== L)
    die(`spin letters differ: ${spins.A?.letter}/${spins.B?.letter}/${spins.C?.letter} vs state ${L}`);
  if (spins.A.spinSeed !== spins.B.spinSeed) die("spin seeds differ between clients");
  ok(`letter "${L}" identical on all 3 clients (seed ${spins.A.spinSeed})`);

  const words = pickWords(L);
  for (const c of CATS) {
    roomA.send("answer", { category: c, text: words[c].shared });
    roomB.send("answer", { category: c, text: words[c].shared.toUpperCase() }); // case-fold dup
    roomC.send("answer", { category: c, text: words[c].solo });
  }
  await sleep(600);
  const pB = roomA.state.players.get(pids.B);
  if (pB.filledCount !== 6) die("filledCount not broadcast, got " + pB.filledCount);
  ok("answers accepted, progress broadcast (6/6)");

  reveals.A = reveals.B = reveals.C = undefined;
  roomB.send("stop");
  const r = await waitFor(() => reveals.A, `round ${n} reveal`);
  if (r.stoppedBy !== pids.B) die("stoppedBy wrong");

  const a = r.scored[pids.A].animal, c = r.scored[pids.C].animal;
  if (a.verdict !== "valid") die(`wordlist word judged ${a.verdict} (${a.raw}): ${a.reason ?? ""}`);
  if (a.unique !== false || !a.dupWith.includes(pids.B)) die("dup detection failed: " + JSON.stringify(a));
  if (c.unique !== true) die("unique detection failed: " + JSON.stringify(c));
  ok(`scoring: Carla ${r.totals[pids.C]} unique · Alice ${r.totals[pids.A]} duplicate`);

  const h = createHash("sha256").update(r.letter + r.nonce).digest("hex");
  if (h !== r.commitHash) die("commit-reveal mismatch");
  ok(`commit-reveal verified (${r.commitHash.slice(0, 12)}…)`);
  return { letter: L, reveal: r };
}

const r1 = await playRound(1);

/* ---------------- table vote ---------------- */

console.log("\n── table vote ──────────────────────────");
await waitFor(() => roomA.state.phase === "REVEAL", "REVEAL phase");
const beforeFlag = roomA.state.players.get(pids.C).roundScore;

roomA.send("challenge", { targetPid: pids.C, category: "animal" });
await waitFor(() => roomA.state.review?.open, "vote sheet to open");
const rv = roomA.state.review;
if (rv.targetPid !== pids.C || rv.category !== "animal") die("wrong answer under review");
if (rv.source !== "peer") die("review source should be 'peer', got " + rv.source);
if (rv.voters !== 2) die("expected 2 eligible voters (author excluded), got " + rv.voters);
ok(`"${rv.answer}" put to the table — 2 eligible voters, author excluded`);

roomC.send("vote", { valid: true });          // the accused: must be ignored
await sleep(250);
if (roomA.state.review?.votesValid !== 0) die("the accused's own vote was counted");
ok("the author's own vote is refused");

roomA.send("vote", { valid: false });
roomB.send("vote", { valid: false });
const result = await waitFor(() => reviews.A?.[0], "review result");
if (result.valid !== false) die("table voted invalid but the answer stood");
if (result.votes.invalid !== 2) die("vote tally wrong: " + JSON.stringify(result.votes));
ok(`table rejected it 0–2 and the round was re-scored`);

await sleep(400);
const afterFlag = roomA.state.players.get(pids.C).roundScore;
if (afterFlag !== beforeFlag - 10) die(`expected Carla to lose 10 (${beforeFlag}→${beforeFlag - 10}), got ${afterFlag}`);
ok(`Carla ${beforeFlag} → ${afterFlag} after the vote`);

/* ---------------- ready gate + banking ---------------- */

console.log("\n── round gate & banking ────────────────");
await waitFor(() => !roomA.state.review?.open, "review queue to drain");

const expected = {};
for (const k of ["A", "B", "C"]) {
  const p = roomA.state.players.get(pids[k]);
  expected[k] = p.totalScore + p.roundScore;
}

roomA.send("ready", { ready: true });
roomB.send("ready", { ready: true });
await sleep(600);
if (["SPINNING", "COUNTDOWN"].includes(roomA.state.phase))
  die("round advanced with only 2 of 3 players ready");
ok("2 of 3 ready does not advance the round");

roomC.send("ready", { ready: true });
await waitFor(() => ["COUNTDOWN", "SPINNING", "WRITING"].includes(roomA.state.phase),
  "round to advance once all 3 are ready");
ok("all 3 ready → next round starts");

// The banking check: points land in totalScore exactly once. A double-count would
// show up here as 2x, because roundScore is zeroed the moment it is banked.
for (const k of ["A", "B", "C"]) {
  const p = roomA.state.players.get(pids[k]);
  const shown = p.totalScore + p.roundScore;
  if (p.totalScore !== expected[k])
    die(`${k}: banked ${p.totalScore}, expected ${expected[k]} (double-count?)`);
  if (shown !== expected[k])
    die(`${k}: scoreboard shows ${shown}, expected ${expected[k]} (total+round double-count)`);
}
ok(`round 1 banked exactly once (A=${expected.A} B=${expected.B} C=${expected.C})`);

/* ---------------- round 2 → match end ---------------- */

const r2 = await playRound(2);
if (r2.letter === r1.letter) console.log("  · note: same letter drawn twice (bag allows it once exhausted)");

console.log("\n── match end ───────────────────────────");
await waitFor(() => roomA.state.phase === "REVEAL", "round 2 REVEAL");
for (const k of ["A", "B", "C"]) rooms[k].send("ready", { ready: true });

const end = await waitFor(() => ends.A, "matchEnd");
const s = end.standings;
if (s.length !== 3) die("expected 3 standings rows");
if (s[0].name !== "Carla") die("standings wrong: " + JSON.stringify(s));
const finalC = roomA.state.players.get(pids.C).totalScore;
if (s[0].score !== finalC) die(`standings score ${s[0].score} != banked total ${finalC}`);
if (s[0].score !== expected.C + 60) die(`Carla should finish on ${expected.C + 60}, got ${s[0].score}`);
ok("standings: " + s.map((x) => `${x.placement}. ${x.name} ${x.score}`).join(" | "));

for (const k of ["A", "B", "C"]) rooms[k].leave();
console.log("\nE2E: ALL PASS ✅\n");
process.exit(0);
