// Headless E2E: 3 clients play a full 1-round match against the live server.
// Verifies: room codes, join-by-code, identical server letter on all clients,
// answer flow, STOP + grace, dup/unique scoring, commit-reveal, standings.
import { Client } from "colyseus.js";

const WS = "ws://localhost:2567";
const API = "http://localhost:2567";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => { console.error("E2E FAIL:", m); process.exit(1); };

const A = new Client(WS), B = new Client(WS), C = new Client(WS);

const spins = {}, reveals = {}, ends = {};
function wire(tag, room) {
  room.onMessage("spin", (p) => (spins[tag] = p));
  room.onMessage("reveal", (p) => (reveals[tag] = p));
  room.onMessage("matchEnd", (p) => (ends[tag] = p));
  room.onMessage("toast", () => {});
  room.onMessage("restore", () => {});
  room.onMessage("challengeResult", () => {});
}

const roomA = await A.create("match", { name: "Alice", lang: "en", rounds: 1, private: true });
wire("A", roomA);
await sleep(400);
const code = roomA.state.roomCode;
if (!/^[A-Z2-9]{6}$/.test(code)) die("bad room code: " + code);
console.log("room code:", code);

const { roomId } = await (await fetch(`${API}/api/resolve/${code}`)).json();
const roomB = await B.joinById(roomId, { name: "Bilal" }); wire("B", roomB);
const roomC = await C.joinById(roomId, { name: "Carla" }); wire("C", roomC);
await sleep(400);

roomA.send("start");
// wait for WRITING (letter revealed in state)
for (let i = 0; i < 100 && roomA.state.phase !== "WRITING"; i++) await sleep(200);
if (roomA.state.phase !== "WRITING") die("never reached WRITING, phase=" + roomA.state.phase);

const L = roomA.state.letter;
if (!L) die("no letter in state");
if (spins.A?.letter !== L || spins.B?.letter !== L || spins.C?.letter !== L)
  die(`spin letters differ: ${spins.A?.letter}/${spins.B?.letter}/${spins.C?.letter} vs state ${L}`);
if (spins.A.spinSeed !== spins.B.spinSeed) die("spin seeds differ between clients");
console.log("letter on all clients:", L, "| seed:", spins.A.spinSeed, "| rotations:", spins.A.rotations);

const cats = ["name", "place", "animal", "food", "object", "celebrity"];
// A and B duplicate on every category; C is unique on every category
for (const k of cats) {
  roomA.send("answer", { category: k, text: L + "shared-" + k });
  roomB.send("answer", { category: k, text: (L + "shared-" + k).toUpperCase() }); // case-fold dup
  roomC.send("answer", { category: k, text: L + "solo-" + k });
}
await sleep(500);
const pB = roomA.state.players.get(roomB.sessionId);
if (pB.filledCount !== 6) die("filledCount not broadcast, got " + pB.filledCount);

roomB.send("stop");
console.log("B called STOP → grace…");
for (let i = 0; i < 200 && !reveals.A; i++) await sleep(200);
if (!reveals.A) die("no reveal received");

const r = reveals.A;
if (r.stoppedBy !== roomB.sessionId) die("stoppedBy wrong");
const a1 = r.scored[roomA.sessionId]["animal"];
const c1 = r.scored[roomC.sessionId]["animal"];
if (a1.unique !== false || !a1.dupWith.includes(roomB.sessionId)) die("dup detection failed: " + JSON.stringify(a1));
if (c1.unique !== true) die("unique detection failed");
if (r.totals[roomC.sessionId] !== 6 * 10) die("unique total wrong: " + r.totals[roomC.sessionId]);
if (r.totals[roomA.sessionId] !== 6 * 5) die("dup total wrong: " + r.totals[roomA.sessionId]);
console.log("scoring ✓  totals:", r.totals);

// provably-fair commit check
const { createHash } = await import("crypto");
const h = createHash("sha256").update(r.letter + r.nonce).digest("hex");
if (h !== r.commitHash) die("commit-reveal mismatch");
console.log("commit-reveal ✓ ", r.commitHash.slice(0, 16) + "…");

for (let i = 0; i < 300 && !ends.A; i++) await sleep(200);
if (!ends.A) die("no matchEnd");
const s = ends.A.standings;
if (s[0].name !== "Carla" || s[0].score !== 60) die("standings wrong: " + JSON.stringify(s));
console.log("standings ✓ ", s.map((x) => `${x.placement}. ${x.name} ${x.score}`).join(" | "));

roomA.leave(); roomB.leave(); roomC.leave();
console.log("\nE2E: ALL PASS ✅");
process.exit(0);
