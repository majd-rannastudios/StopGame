/**
 * Optional durable persistence to Supabase via PostgREST.
 * No-op unless SUPABASE_URL + SUPABASE_SERVICE_KEY are set — the game never
 * depends on it. Service key stays server-side ONLY (never ship it to clients).
 */
export async function persistMatch(payload: {
  roomCode: string;
  language: string;
  ruleset: unknown;
  rounds: unknown[];
  standings: { pid: string; name: string; score: number; placement: number }[];
}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/matches`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        room_code: payload.roomCode,
        language: payload.language,
        ruleset: payload.ruleset,
        rounds: payload.rounds,
        standings: payload.standings,
        ended_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.error("persistMatch failed (non-fatal)", e);
  }
}
