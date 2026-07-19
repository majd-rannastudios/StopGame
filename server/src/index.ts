import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { MatchRoom } from "./rooms/MatchRoom";
import { resolveCode } from "./codeRegistry";

// A single bad client interaction (e.g. joining a room mid-match) must never take down
// every other room's live match. Log and keep serving instead of letting the process die.
process.on("uncaughtException", (err) => {
  console.error("uncaughtException (server kept running):", err);
});
process.on("unhandledRejection", (reason) => {
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

app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

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

server.listen(PORT).then(() => console.log(`⛔ STOP game server listening on :${PORT}`));
