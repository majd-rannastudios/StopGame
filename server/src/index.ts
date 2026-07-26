import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { MatchRoom } from "./rooms/MatchRoom";
import { resolveCode } from "./codeRegistry";
import { isAIAvailable } from "./validation/engine";

/**
 * A single bad client interaction (e.g. joining a room mid-match) must never take down
 * every other room's live match. Log and keep serving instead of letting the process die.
 *
 * The guard only arms once we are actually listening: a crash during boot — a port
 * already in use, a bad config — has to be fatal. Swallowing it leaves a process that
 * answers nothing while looking perfectly alive.
 */
let serving = false;
const fatal = (label: string, err: unknown) => {
  console.error(`${label} during startup — exiting:`, err);
  process.exit(1);
};
process.on("uncaughtException", (err) => {
  if (!serving) return fatal("uncaughtException", err);
  console.error("uncaughtException (server kept running):", err);
});
process.on("unhandledRejection", (reason) => {
  if (!serving) return fatal("unhandledRejection", reason);
  console.error("unhandledRejection (server kept running):", reason);
});

const PORT = Number(process.env.PORT || 2567);
const ORIGIN = process.env.CORS_ORIGIN || "*"; // set to your web origin in production

const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json({ limit: "16kb" }));

// tiny hardening without extra deps
app.disable("x-powered-by");
app.use((_, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

/**
 * Health + referee status. Whether the referee is configured is already broadcast to
 * every client in room state, so nothing is disclosed here that players can't see —
 * but having it on a plain GET means "is the key actually live on this deploy?" is
 * one curl instead of joining a room and playing a round to find out.
 */
app.get("/health", (_, res) =>
  res.json({
    ok: true,
    ts: Date.now(),
    aiReferee: isAIAvailable(),
    model: isAIAvailable() ? process.env.AI_VALIDATOR_MODEL || "claude-haiku-4-5" : null,
  })
);

/** Resolve an invite code → live roomId so the client can joinById. */
app.get("/api/resolve/:code", (req, res) => {
  const roomId = resolveCode(req.params.code || "");
  if (!roomId) return res.status(404).json({ error: "room_not_found" });
  res.json({ roomId });
});

/** Quick Match: join any waiting public room in this language, else create one. */
app.post("/api/quickmatch", async (req, res) => {
  try {
    const lang = ["en", "fr", "ar"].includes(req.body?.lang) ? req.body.lang : "en";
    const rooms = await matchMaker.query({ name: "match" });
    const open = rooms.find(
      (r) => !r.locked && !r.private && r.metadata?.lang === lang && r.clients < r.maxClients
    );
    if (open) return res.json({ roomId: open.roomId });
    const created = await matchMaker.createRoom("match", { lang, ranked: false, private: false });
    res.json({ roomId: created.roomId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "matchmaking_failed" });
  }
});

const server = new Server({
  transport: new WebSocketTransport({ server: http.createServer(app) }),
});
server.define("match", MatchRoom);

server
  .listen(PORT)
  .then(() => {
    serving = true;
    console.log(`⛔ STOP game server listening on :${PORT}`);
    // Say this out loud at boot: without a key every unknown word is unjudged, which
    // is a very different game, and it is otherwise invisible until players complain.
    if (isAIAvailable()) {
      console.log(`   AI referee: ON (${process.env.AI_VALIDATOR_MODEL || "claude-haiku-4-5"})`);
    } else {
      console.warn("   AI referee: OFF — ANTHROPIC_API_KEY is not set.");
      console.warn("   Answers outside the wordlist cannot be judged and will be accepted as-is.");
    }
  })
  .catch((err) => fatal("listen failed", err));
