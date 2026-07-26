/**
 * Solo mode: one player against the clock. No lobby, no opponents, no table votes,
 * and nobody can join the room. Run against a live server.
 */
import { Client } from "colyseus.js";
import { readFileSync } from "fs";
const WORDS = JSON.parse(readFileSync("server/src/wordlists/en.json", "utf8"));
const CATS = ["name","place","animal","food","object","celebrity"];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const die = m => { console.error("\nFAIL:", m); process.exit(1); };
const ok = m => console.log("  ✓", m);

const A = new Client("ws://localhost:2567");
const r = await A.create("match", { name: "Majd", lang: "en", rounds: 2, roundSeconds: 30, solo: true });
let reveal = null, ended = null, reviewOpened = false;
r.onMessage("reveal", p => (reveal = p));
r.onMessage("matchEnd", p => (ended = p));
r.onMessage("*", () => {});
await sleep(500);

if (!r.state.solo) die("state.solo not set");
ok("room reports solo");

// solo starts itself — no lobby to wait in
r.send("start");
for (let i = 0; i < 200 && r.state.phase !== "WRITING"; i++) {
  if (r.state.review?.open) reviewOpened = true;
  await sleep(150);
}
if (r.state.phase !== "WRITING") die("solo never reached WRITING (phase=" + r.state.phase + ")");
ok("one player can start a match alone");

// a second client must be refused
let joined = false;
try {
  const B = new Client("ws://localhost:2567");
  const { roomId } = await (await fetch(`http://localhost:2567/api/resolve/${r.state.roomCode}`)).json();
  await B.joinById(roomId, { name: "Intruder" });
  joined = true;
} catch { /* expected */ }
if (joined) die("a second player was allowed into a solo room");
ok("a second player is refused");

async function round(n) {
  for (let i = 0; i < 200 && r.state.phase !== "WRITING"; i++) await sleep(150);
  const L = r.state.letter.toLowerCase();
  for (const c of CATS) {
    const w = WORDS[c].find(x => x.toLowerCase().startsWith(L));
    r.send("answer", { category: c, text: w });
  }
  await sleep(600);
  reveal = null;
  r.send("stop");
  for (let i = 0; i < 300 && !reveal; i++) {
    if (r.state.review?.open) reviewOpened = true;
    await sleep(150);
  }
  if (!reveal) die(`round ${n}: no reveal`);
  // nothing may be labelled 'to the table' in solo — there is no table
  const mislabelled = CATS.filter(c => reveal.scored[r.sessionId]?.[c]?.pendingReview);
  if (mislabelled.length) {
    die(`round ${n}: ${mislabelled.join(", ")} labelled "to the table" with nobody to vote`);
  }
  const mine = reveal.totals[r.sessionId];
  if (mine !== 60) die(`round ${n}: expected 60 (6 x unique), got ${mine}`);
  ok(`round ${n}: all six valid, ${mine} points (nothing to duplicate against)`);
  // advance
  for (let i = 0; i < 200 && !["REVEAL","SCORED"].includes(r.state.phase); i++) await sleep(150);
  r.send("ready", { ready: true });
}

await round(1);
await round(2);

for (let i = 0; i < 300 && !ended; i++) { if (r.state.review?.open) reviewOpened = true; await sleep(150); }
if (!ended) die("no matchEnd");
if (reviewOpened) die("a table vote opened in solo — there is nobody to vote");
ok("no table vote ever opened");
if (ended.standings.length !== 1) die("expected 1 standings row, got " + ended.standings.length);
if (ended.standings[0].score !== 120) die("expected 120 total, got " + ended.standings[0].score);
ok(`final: ${ended.standings[0].name} ${ended.standings[0].score}`);

r.leave();
console.log("\nSOLO: ALL PASS ✅\n");
process.exit(0);
