/**
 * Checks the layer-2 → layer-3 handoff: an answer the AI referee cannot confirm must
 * open a table vote by itself, carrying the referee's own reason to the voters.
 *
 * Needs ANTHROPIC_API_KEY (one cheap Haiku call). The main e2e deliberately avoids the
 * AI, so this is the only test of that seam. Run it against a live server:
 *
 *   node tools/ai-review-check.mjs
 */
import { Client } from "colyseus.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CATS = ["name","place","animal","food","object","celebrity"];

const A = new Client("ws://localhost:2567"), B = new Client("ws://localhost:2567");
const rA = await A.create("match", { name: "Alice", lang: "en", rounds: 1, roundSeconds: 30, private: true });
const reviews = [];
rA.onMessage("reviewResult", p => reviews.push(p));
rA.onMessage("*", () => {});
await sleep(400);
const { roomId } = await (await fetch(`http://localhost:2567/api/resolve/${rA.state.roomCode}`)).json();
const rB = await B.joinById(roomId, { name: "Bilal" });
rB.onMessage("*", () => {});
await sleep(400);

rA.send("start");
for (let i = 0; i < 200 && rA.state.phase !== "WRITING"; i++) await sleep(150);
const L = rA.state.letter;
console.log("letter:", L);

// Alice: an obscure-but-plausible local celebrity the referee should not be able to confirm.
const obscure = `${L}amir ${L}oubaidi`;
const filler = { name: L+"aa", place: L+"bb", animal: L+"cc", food: L+"dd", object: L+"ee" };
for (const c of CATS) {
  rA.send("answer", { category: c, text: c === "celebrity" ? obscure : filler[c] });
  rB.send("answer", { category: c, text: c === "celebrity" ? L+"ahmed "+L+"ali" : filler[c]+"x" });
}
await sleep(600);
rA.send("stop");

for (let i = 0; i < 300 && rA.state.phase !== "REVEAL"; i++) await sleep(150);
console.log("phase:", rA.state.phase);
for (let i = 0; i < 100 && !rA.state.review?.open; i++) await sleep(150);

if (!rA.state.review?.open) {
  console.log("no automatic review opened — the referee settled everything on its own");
  const cell = rA.state.players.get(rA.sessionId);
  process.exit(0);
}
const rv = rA.state.review;
console.log(`\nAUTO REVIEW OPENED`);
console.log("  answer :", JSON.stringify(rv.answer));
console.log("  source :", rv.source, "(expect 'ai')");
console.log("  reason :", JSON.stringify(rv.reason));
console.log("  voters :", rv.voters);
if (rv.source !== "ai") { console.error("FAIL: expected an AI-raised review"); process.exit(1); }
// the non-author votes it down
const voter = rv.targetPid === rA.sessionId ? rB : rA;
voter.send("vote", { valid: false });
for (let i = 0; i < 100 && !reviews.length; i++) await sleep(150);
console.log("  result :", JSON.stringify(reviews[0]?.votes), "valid =", reviews[0]?.valid);
console.log("\nAI-unsure → table vote: WORKS ✅");
rA.leave(); rB.leave();
process.exit(0);
