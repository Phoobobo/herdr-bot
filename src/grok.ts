// Grok Build (`grok` CLI) body support: model validation, session ids, and
// structured write-back from grok's own session log (updates.jsonl).
//
// Sources (Grok Build 1.0.70, xai-grok-shell @ 559751fd):
// - Session dir: ~/.grok/sessions/<urlencoding::encode(cwd)>/<session-id>/
//   (GROK_HOME overrides ~/.grok). Docs: ~/.grok/docs/user-guide/17-sessions.md.
// - updates.jsonl is the append-only, authoritative ACP log. Each line is a
//   SessionUpdateEnvelope (session/storage/mod.rs):
//     {"timestamp":<secs>,"method":"session/update"|"_x.ai/session/update",
//      "params":{"sessionId":"…","update":{"sessionUpdate":"…",…}}}
// - Persisted ACP updates: user_message_chunk, agent_message_chunk,
//   agent_thought_chunk, tool_call, tool_call_update, plan, …; consecutive text
//   chunks are merged before write (persistence.rs maybe_merge_notification).
// - Every turn ends with a durable xAI `turn_completed`
//   {prompt_id, stop_reason, agent_result?, error_kind?, usage?, elapsed_ms?}
//   (extensions/notification.rs, session/turn_completion.rs).
// - `grok -s/--session-id <UUID>` pins the id of a NEW session;
//   `grok -r/--resume <ID>` resumes one (xai-grok-pager/src/app/cli.rs).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotError } from "./types.ts";

export const DEFAULT_GROK_MODEL = "grok-4.7";

export function grokBin(): string {
  const p = process.env.GROK_BIN_PATH?.trim();
  return p && p.length > 0 ? p : "grok";
}

export function grokHome(): string {
  const p = process.env.GROK_HOME?.trim();
  return p && p.length > 0 ? p : path.join(os.homedir(), ".grok");
}

// ---------------------------------------------------------------- models

/**
 * Parse `grok models`. Real 1.0.70 output (captured on the box, logged out):
 *   You are not authenticated.
 *
 *   Default model: grok-4.6
 *
 *   Available models:
 *     * grok-4.6 (default)
 *     - grok-4.5
 */
export function parseGrokModels(stdout: string): string[] {
  const listed: string[] = [];
  const bullets: string[] = [];
  let inList = false;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^available models\s*:/i.test(line)) {
      inList = true;
      continue;
    }
    const m = line.match(/^[*-]\s+([A-Za-z0-9][A-Za-z0-9._:\/-]*)/);
    if (!m) continue;
    bullets.push(m[1]);
    if (inList) listed.push(m[1]);
  }
  return [...new Set(listed.length ? listed : bullets)];
}

export type GrokModelsRunner = () => { stdout: string; stderr: string; exitCode: number };

const defaultModelsRunner: GrokModelsRunner = () => {
  const proc = Bun.spawnSync([grokBin(), "models"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode ?? 1 };
};

let modelsRunner: GrokModelsRunner = defaultModelsRunner;
let modelsCache: string[] | null = null;

/** Tests inject a fake `grok models`; null restores the real binary. */
export function setGrokModelsRunner(next: GrokModelsRunner | null): void {
  modelsRunner = next ?? defaultModelsRunner;
  modelsCache = null;
}

/** HERDR_BOT_GROK_MODELS (comma/space list) overrides `grok models`. */
export function listGrokModels(): string[] {
  const override = process.env.HERDR_BOT_GROK_MODELS?.trim();
  if (override) return override.split(/[,\s]+/).filter(Boolean);
  if (modelsCache) return modelsCache;
  let res: ReturnType<GrokModelsRunner>;
  try {
    res = modelsRunner();
  } catch (err) {
    throw new BotError(
      "GROK_MODELS",
      `could not run \`${grokBin()} models\`: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.exitCode !== 0) {
    throw new BotError("GROK_MODELS", `\`${grokBin()} models\` failed: ${(res.stderr || res.stdout).trim()}`);
  }
  const models = parseGrokModels(res.stdout);
  // Cache only a usable list; a logged-out grok may list more after login.
  if (models.length) modelsCache = models;
  return models;
}

/** Throw a clear error when `model` is not listed by `grok models`. */
export function assertGrokModel(model: string): string {
  const id = model.trim();
  if (!id) throw new BotError("GROK_MODEL", "grok model id is empty");
  const available = listGrokModels();
  if (!available.includes(id)) {
    throw new BotError(
      "GROK_MODEL",
      `grok model "${id}" is not listed by \`grok models\` (available: ${available.join(", ") || "none"}). ` +
        "Log in with `grok login`, or set another model with `herdr-bots bots model <bot> --model <id>`.",
    );
  }
  return id;
}

// ---------------------------------------------------------------- sessions

/** urlencoding::encode: everything except ASCII alnum and -._~ is %XX (UTF-8). */
export function encodeCwdForGrok(cwd: string): string {
  let out = "";
  for (const byte of Buffer.from(cwd, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(id: string | null | undefined): id is string {
  return !!id && UUID_RE.test(id);
}

/** Fresh session id for `grok --session-id`. Grok itself mints UUIDv7. */
export function newGrokSessionId(): string {
  const ms = BigInt(Date.now());
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Locate `<GROK_HOME>/sessions/<cwd dir>/<id>/`. Tries the encoded cwd first,
 * then any cwd dir (long cwds are stored as slug+hash with a `.cwd` file).
 */
export function findGrokSessionDir(sessionId: string, cwd?: string): string | null {
  if (!isUuid(sessionId)) return null;
  const root = path.join(grokHome(), "sessions");
  if (cwd) {
    const direct = path.join(root, encodeCwdForGrok(cwd), sessionId);
    if (fs.existsSync(direct)) return direct;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = path.join(root, e.name, sessionId);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function grokUpdatesPath(sessionId: string, cwd?: string): string | null {
  const dir = findGrokSessionDir(sessionId, cwd);
  return dir ? path.join(dir, "updates.jsonl") : null;
}

/** Byte length of updates.jsonl now (0 when the session has no log yet). */
export function grokUpdatesOffset(sessionId: string, cwd?: string): number {
  const file = grokUpdatesPath(sessionId, cwd);
  if (!file) return 0;
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- write-back

export interface GrokUpdate {
  method: string;
  update: Record<string, any>;
}

/** Parse updates.jsonl text. Torn / blank / payloadless lines are skipped like grok does. */
export function parseGrokUpdates(jsonl: string): GrokUpdate[] {
  const out: GrokUpdate[] = [];
  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let env: any;
    try {
      env = JSON.parse(line);
    } catch {
      continue;
    }
    const update = env?.params?.update;
    if (!update || typeof update !== "object" || typeof update.sessionUpdate !== "string") continue;
    out.push({ method: String(env.method ?? ""), update });
  }
  return out;
}

export interface GrokTurn {
  /** Assistant-visible text of the last turn, verbatim (no thoughts, no tool output). */
  text: string;
  completed: boolean;
  stopReason: string | null;
  error: string | null;
  /** tool_call count in the turn; when > 0, `text` is only the segment after the last one. */
  toolCalls: number;
}

function chunkText(update: Record<string, any>): string | null {
  const c = update.content;
  if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") return c.text;
  return null;
}

function isRealUserChunk(update: Record<string, any>): boolean {
  if (update.sessionUpdate !== "user_message_chunk") return false;
  const meta = update._meta;
  return !(meta && typeof meta === "object" && (meta.hostTurn === true || meta.interjection === true));
}

function normPrompt(s: string): string {
  return s.replace(/\r\n?/g, "\n").trim();
}

interface RawTurn {
  user: string;
  events: Array<Record<string, any>>;
}

/** Split an updates.jsonl slice into turns: a run of real user chunks, then everything until the next run. */
function splitTurns(jsonl: string): RawTurn[] {
  const turns: RawTurn[] = [];
  let cur: RawTurn | null = null;
  let inUser = false;
  for (const { update } of parseGrokUpdates(jsonl)) {
    if (isRealUserChunk(update)) {
      if (!cur || !inUser) {
        cur = { user: "", events: [] };
        turns.push(cur);
      }
      inUser = true;
      cur.user += chunkText(update) ?? "";
      continue;
    }
    inUser = false;
    if (!cur) {
      // Slice started mid-turn (no user chunk): treat the head as its own turn.
      cur = { user: "", events: [] };
      turns.push(cur);
    }
    cur.events.push(update);
  }
  return turns;
}

function foldTurn(events: Array<Record<string, any>>): GrokTurn {
  // QA acceptance: the stored reply is the final user-facing message. When a
  // turn has tool calls, only agent_message_chunk text after the LAST tool
  // call/update counts; earlier narration ("Let me look…") is dropped and never
  // stored. A turn ending on a tool call has no reply text.
  let current = "";
  let toolCalls = 0;
  let completed = false;
  let stopReason: string | null = null;
  let error: string | null = null;
  for (const u of events) {
    const kind = u.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const t = chunkText(u);
      if (t != null) current += t;
      continue;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      if (kind === "tool_call") toolCalls++;
      else if (toolCalls === 0) toolCalls = 1;
      current = "";
      continue;
    }
    if (kind === "turn_completed") {
      completed = true;
      stopReason = typeof u.stop_reason === "string" ? u.stop_reason : null;
      // sampling/error.rs prompt_complete_fields: Ok -> (stop_reason, null);
      // Err -> ("error" | "rate_limit", message | null, error_kind?).
      if (stopReason === "error" || stopReason === "rate_limit" || (typeof u.error_kind === "string" && u.error_kind)) {
        error =
          (typeof u.agent_result === "string" && u.agent_result.trim() ? u.agent_result : null) ??
          (typeof u.error_kind === "string" && u.error_kind ? u.error_kind : null) ??
          (stopReason === "rate_limit" ? "rate limited" : "error");
      }
      break;
    }
    // agent_thought_chunk, plan, usage, retry, … are not part of the reply.
  }
  return { text: current.trim() ? current : "", completed, stopReason, error, toolCalls };
}

/**
 * Reply of one turn in an updates.jsonl slice.
 * - With `prompt`: the FIRST turn whose user text is that prompt (so two
 *   quick sends to one session each read their own turn). Not found yet →
 *   completed=false.
 * - Without: the last turn in the slice.
 * Text is agent_message_chunk only (verbatim); with tool calls, only the text
 * after the last tool call.
 */
export function grokTurnFromUpdates(jsonl: string, opts: { prompt?: string } = {}): GrokTurn {
  const turns = splitTurns(jsonl);
  let turn: RawTurn | undefined;
  if (opts.prompt != null) {
    const want = normPrompt(opts.prompt);
    turn = turns.find((t) => normPrompt(t.user) === want) ?? turns.find((t) => t.user && normPrompt(t.user).includes(want));
    if (!turn) return { text: "", completed: false, stopReason: null, error: null, toolCalls: 0 };
  } else {
    turn = turns.at(-1);
  }
  return foldTurn(turn?.events ?? []);
}

/** Read updates.jsonl bytes appended since `offset` (whole file if it shrank). */
export function readGrokUpdatesSince(sessionId: string, offset: number, cwd?: string): string {
  const file = grokUpdatesPath(sessionId, cwd);
  if (!file) return "";
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return "";
  }
  const from = offset > 0 && offset <= buf.length ? offset : 0;
  return buf.subarray(from).toString("utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait (bounded) for grok to persist `turn_completed` for the prompt sent
 * after `offset`, then return the reply text. herdr's `--wait` can return a
 * beat before grok's buffered writer lands the final chunk.
 */
export async function waitForGrokReply(
  sessionId: string,
  offset: number,
  opts: { cwd?: string; graceMs?: number; pollMs?: number; prompt?: string } = {},
): Promise<string> {
  const envGrace = Number(process.env.HERDR_BOT_GROK_REPLY_GRACE_MS);
  const graceMs = opts.graceMs ?? (Number.isFinite(envGrace) && envGrace >= 0 ? envGrace : 20_000);
  const pollMs = opts.pollMs ?? 150;
  const deadline = Date.now() + graceMs;
  for (;;) {
    const turn = grokTurnFromUpdates(readGrokUpdatesSince(sessionId, offset, opts.cwd), { prompt: opts.prompt });
    if (turn.completed) {
      if (turn.error) {
        throw new BotError("GROK_TURN", `grok turn ended with ${turn.stopReason ?? "error"}: ${turn.error}`);
      }
      if (!turn.text.trim() && turn.toolCalls > 0) {
        throw new BotError(
          "GROK_TURN",
          `grok turn ended (${turn.stopReason ?? "unknown"}) on a tool call with no final reply text after it`,
        );
      }
      if (!turn.text.trim()) {
        throw new BotError("GROK_TURN", `grok turn ended (${turn.stopReason ?? "unknown"}) with no reply text`);
      }
      return turn.text;
    }
    if (Date.now() >= deadline) {
      const where = grokUpdatesPath(sessionId, opts.cwd) ?? `${grokHome()}/sessions/*/${sessionId}/updates.jsonl`;
      throw new BotError(
        "GROK_TURN",
        `grok session ${sessionId} has no turn_completed in ${where} (agent may be blocked on an approval or still running)`,
      );
    }
    await sleep(pollMs);
  }
}
