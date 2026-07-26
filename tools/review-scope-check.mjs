/**
 * Guards the two ways the table vote goes wrong.
 *
 * 1. Referee OFF (no ANTHROPIC_API_KEY): every unknown word comes back unjudged.
 *    That is an outage, not a hard word — it must produce NO votes at all, or the
 *    room spends the whole reveal rubber-stamping ordinary answers.
 * 2. Referee ON: only a given name or a famous person may reach the table. Whether
 *    something is an animal, a place, a food or an object is a matter of fact and
 *    the referee settles it alone.
 *
 * Run twice against a live server, once per mode:
 *   ANTHROPIC_API_KEY= node server/dist/index.js   →  node tools/review-scope-check.mjs off
 *   node server/dist/index.js                      →  node tools/review-scope-check.mjs on
 */
import { Client } from "colyseus.js";

const MODE = process.argv[2] === "on" ? "on" : "off";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => { console.error("\nFAIL:", m); process.exit(1); };

// Deliberately not in any wordlist, so every one of them reaches the referee.
const OBSCURE = {
  name: (L) => `${L}orvan`,
  place: (L) => `${L}urnwick`,
  animal: (L) => `${L}orralope`,
  food: (L) => `${L}umberry`,
  object: (L) => `${L}rimlot`,
  celebrity: (L) => `${L}amir ${L}oubaidi`,
};
const CATS = Object.keys(OBSCURE);

const A = new Client("ws://localhost:2567"), B = new Client("ws://localhost:2567");
const rA = await A.create("match", { name: "Alice", lang: "en", rounds: 1, roundSeconds: 30, private: true });
rA.onMessage("*", () => {});
await sleep(400);
const { roomId } = await (await fetch(`http://localhost:2567/api/resolve/${rA.state.roomCode}`)).json();
const rB = await B.joinById(roomId, { name: "Bilal" });
rB.onMessage("*", () => {});
await sleep(400);

if (rA.state.aiReferee !== (MODE === "on")) {
  die(`server reports aiReferee=${rA.state.aiReferee} but this run expects the referee ${MODE}`);
}
console.log(`server referee: ${rA.state.aiReferee ? "ON" : "OFF"} (as expected for mode "${MODE}")`);

rA.send("start");
for (let i = 0; i < 300 && rA.state.phase !== "WRITING"; i++) await sleep(150);
const L = rA.state.letter.toLowerCase();
for (const c of CATS) {
  rA.send("answer", { category: c, text: OBSCURE[c](L) });
  rB.send("answer", { category: c, text: OBSCURE[c](L) + "en" });
}
await sleep(700);
rA.send("stop");

// Watch the whole reveal and record every category that reached the table.
const seen = new Set();
for (let i = 0; i < 400; i++) {
  const r = rA.state.review;
  if (r?.open) seen.add(r.category);
  if (["SCORED", "MATCH_END", "LOBBY"].includes(rA.state.phase)) break;
  await sleep(150);
}

const cats = [...seen];
console.log("categories put to the table:", cats.length ? cats.join(", ") : "(none)");

if (MODE === "off") {
  if (cats.length) die(`referee is OFF yet ${cats.length} answer(s) went to a vote: ${cats.join(", ")}\n` +
    "      An outage must not turn into a room-wide rubber-stamping session.");
  console.log("\n✅ referee OFF → no table votes; unjudged answers simply stand");
} else {
  const bad = cats.filter((c) => c !== "name" && c !== "celebrity");
  if (bad.length) die(`objective categories reached the table: ${bad.join(", ")}\n` +
    "      Only 'name' and 'celebrity' may ever be put to a vote automatically.");
  console.log("\n✅ referee ON → only name/celebrity can reach the table" +
    (cats.length ? "" : " (referee settled everything itself this round)"));
}
rA.leave(); rB.leave();
process.exit(0);
