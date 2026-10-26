import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertGrokModel,
  encodeCwdForGrok,
  findGrokSessionDir,
  grokTurnFromUpdates,
  grokUpdatesOffset,
  isUuid,
  listGrokModels,
  newGrokSessionId,
  parseGrokModels,
  parseGrokUpdates,
  setGrokModelsRunner,
  waitForGrokReply,
} from "./grok.ts";
import {
  CODE_BLOCK_REPLY,
  LONG_CHINESE_REPLY,
  MULTILINE_REPLY,
  agentChunk,
  chunked,
  thoughtChunk,
  toolCall,
  toolCallDone,
  turnCompleted,
  turnLines,
  userChunk,
} from "./grok.fixtures.ts";

let home: string;
const SID = "019a0b7c-1d2e-7f30-8a41-b2c3d4e5f607";
const CWD = "/Users/phoobobo/Workspace/herdr-bot";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-bot-grok-"));
  process.env.GROK_HOME = home;
  delete process.env.HERDR_BOT_GROK_MODELS;
});

afterEach(() => {
  setGrokModelsRunner(null);
  delete process.env.GROK_HOME;
  delete process.env.HERDR_BOT_GROK_MODELS;
  fs.rmSync(home, { recursive: true, force: true });
});

function sessionDir(): string {
  const d = path.join(home, "sessions", encodeCwdForGrok(CWD), SID);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function append(lines: string[]): void {
  fs.appendFileSync(path.join(sessionDir(), "updates.jsonl"), lines.map((l) => `${l}\n`).join(""));
}

// Real `grok models` stdout (Grok Build 1.0.70, logged out) captured on the box.
const GROK_MODELS_LOGGED_OUT = `You are not authenticated.

Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5
`;

test("parseGrokModels reads the real `grok models` list", () => {
  expect(parseGrokModels(GROK_MODELS_LOGGED_OUT)).toEqual(["grok-4.6", "grok-4.5"]);
  expect(parseGrokModels("")).toEqual([]);
});

test("assertGrokModel fails clearly when grok-4.7 is not listed", () => {
  setGrokModelsRunner(() => ({ stdout: GROK_MODELS_LOGGED_OUT, stderr: "", exitCode: 0 }));
  expect(() => assertGrokModel("grok-4.7")).toThrow(/grok model "grok-4\.7" is not listed.*grok-4\.6, grok-4\.5/);
  expect(assertGrokModel("grok-4.6")).toBe("grok-4.6");
});

test("assertGrokModel accepts a listed model; HERDR_BOT_GROK_MODELS overrides", () => {
  setGrokModelsRunner(() => ({ stdout: "Available models:\n  * grok-4.7 (default)\n  - grok-4.6\n", stderr: "", exitCode: 0 }));
  expect(assertGrokModel("grok-4.7")).toBe("grok-4.7");
  process.env.HERDR_BOT_GROK_MODELS = "grok-x";
  expect(listGrokModels()).toEqual(["grok-x"]);
  expect(() => assertGrokModel("grok-4.7")).toThrow(/not listed/);
});

test("session ids are UUIDv7 and grok cwd encoding matches urlencoding", () => {
  const id = newGrokSessionId();
  expect(isUuid(id)).toBe(true);
  expect(id[14]).toBe("7");
  expect(encodeCwdForGrok("/Users/phoobobo/Workspace/herdr-bot")).toBe("%2FUsers%2Fphoobobo%2FWorkspace%2Fherdr-bot");
  expect(encodeCwdForGrok("/tmp/a b/中")).toBe("%2Ftmp%2Fa%20b%2F%E4%B8%AD");
});

test("findGrokSessionDir finds the encoded cwd dir and falls back to a scan", () => {
  expect(findGrokSessionDir(SID, CWD)).toBeNull();
  const d = sessionDir();
  expect(findGrokSessionDir(SID, CWD)).toBe(d);
  // Long cwds are stored as slug+hash dirs; scan finds them without the cwd.
  const other = path.join(home, "sessions", "very-long-slug-1a2b3c", "019a0b7c-0000-7000-8000-000000000001");
  fs.mkdirSync(other, { recursive: true });
  expect(findGrokSessionDir("019a0b7c-0000-7000-8000-000000000001", CWD)).toBe(other);
  expect(findGrokSessionDir("not-a-uuid")).toBeNull();
});

for (const [label, reply] of [
  ["multi-line", MULTILINE_REPLY],
  ["code block", CODE_BLOCK_REPLY],
  ["long Chinese", LONG_CHINESE_REPLY],
] as const) {
  test(`grokTurnFromUpdates returns the ${label} reply verbatim`, () => {
    const jsonl = turnLines(SID, "[dm] Phoobobo: hi", reply).join("\n") + "\n";
    const turn = grokTurnFromUpdates(jsonl);
    expect(turn.completed).toBe(true);
    expect(turn.stopReason).toBe("end_turn");
    expect(turn.error).toBeNull();
    expect(turn.text).toBe(reply);
  });
}

test("only the last turn is returned; thoughts are dropped", () => {
  const jsonl = [
    ...turnLines(SID, "first", "old reply", 0),
    ...turnLines(SID, "second", LONG_CHINESE_REPLY, 1),
  ].join("\n");
  const turn = grokTurnFromUpdates(jsonl);
  expect(turn.text).toBe(LONG_CHINESE_REPLY);
  expect(turn.text).not.toContain("old reply");
  expect(turn.text).not.toContain("Planning");
});

test("tool call in the middle: only the final segment is stored; hostTurn user chunks don't reset the turn", () => {
  const host = JSON.stringify({
    timestamp: 1,
    method: "session/update",
    params: {
      sessionId: SID,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "<system-reminder>" }, _meta: { hostTurn: true } },
    },
  });
  const jsonl = [
    userChunk(SID, "check the file"),
    agentChunk(SID, "Let me look."),
    toolCall(SID, "t1", "Read src/a.ts"),
    host,
    toolCallDone(SID, "t1"),
    agentChunk(SID, "It exports "),
    agentChunk(SID, "`add`."),
    turnCompleted(SID),
  ].join("\n");
  const turn = grokTurnFromUpdates(jsonl);
  expect(turn.text).toBe("It exports `add`.");
  expect(turn.text).not.toContain("Let me look.");
  expect(turn.toolCalls).toBe(1);
});

test("torn / garbage lines are skipped like grok's own reader", () => {
  const lines = turnLines(SID, "p", CODE_BLOCK_REPLY);
  const jsonl = ["{\"timestamp\":1,\"method\":\"session/up", ...lines, "not json", "{\"params\":{}}"].join("\n");
  expect(parseGrokUpdates(jsonl).length).toBe(lines.length);
  expect(grokTurnFromUpdates(jsonl).text).toBe(CODE_BLOCK_REPLY);
});

test("incomplete turn reports completed=false", () => {
  const jsonl = [userChunk(SID, "p"), agentChunk(SID, "partial")].join("\n");
  expect(grokTurnFromUpdates(jsonl)).toEqual({ text: "partial", completed: false, stopReason: null, error: null, toolCalls: 0 });
});

test("error stop surfaces agent_result as an error", () => {
  const jsonl = [
    userChunk(SID, "p"),
    turnCompleted(SID, "error", { agent_result: "Not signed in.", error_kind: "auth" }),
  ].join("\n");
  const turn = grokTurnFromUpdates(jsonl);
  expect(turn.completed).toBe(true);
  expect(turn.error).toBe("Not signed in.");
});

test("waitForGrokReply reads only bytes after the baseline offset", async () => {
  append(turnLines(SID, "old", "old reply"));
  const offset = grokUpdatesOffset(SID, CWD);
  expect(offset).toBeGreaterThan(0);
  // Reply lands a beat after `agent prompt --wait` returns.
  setTimeout(() => append(turnLines(SID, "new", MULTILINE_REPLY, 1)), 30);
  expect(await waitForGrokReply(SID, offset, { cwd: CWD, graceMs: 2000, pollMs: 10 })).toBe(MULTILINE_REPLY);
});

test("waitForGrokReply times out clearly without turn_completed", async () => {
  append([userChunk(SID, "p"), agentChunk(SID, "partial")]);
  await expect(waitForGrokReply(SID, 0, { cwd: CWD, graceMs: 50, pollMs: 10 })).rejects.toThrow(/no turn_completed/);
});

test("waitForGrokReply throws on an error stop", async () => {
  append([userChunk(SID, "p"), turnCompleted(SID, "rate_limit")]);
  await expect(waitForGrokReply(SID, 0, { cwd: CWD, graceMs: 50, pollMs: 10 })).rejects.toThrow(/rate_limit/);
});

test("thought-only turn is not a reply", async () => {
  append([userChunk(SID, "p"), thoughtChunk(SID, "hmm"), turnCompleted(SID)]);
  await expect(waitForGrokReply(SID, 0, { cwd: CWD, graceMs: 50, pollMs: 10 })).rejects.toThrow(/no reply text/);
});

test("multiple tool calls: only the text after the LAST one is stored", () => {
  const jsonl = [
    userChunk(SID, "fix it"),
    agentChunk(SID, "Reading."),
    toolCall(SID, "t1", "Read a.ts"),
    toolCallDone(SID, "t1"),
    agentChunk(SID, "Now editing."),
    toolCall(SID, "t2", "Edit a.ts"),
    agentChunk(SID, "still working"),
    toolCallDone(SID, "t2"),
    ...chunked(CODE_BLOCK_REPLY).map((c) => agentChunk(SID, c)),
    turnCompleted(SID),
  ].join("\n");
  const turn = grokTurnFromUpdates(jsonl);
  expect(turn.text).toBe(CODE_BLOCK_REPLY);
  expect(turn.toolCalls).toBe(2);
  for (const early of ["Reading.", "Now editing.", "still working"]) expect(turn.text).not.toContain(early);
});

test("a turn ending on a tool call with no text after it raises GROK_TURN", async () => {
  const home = process.env.GROK_HOME!;
  const sid = "019a0b7c-1111-7222-8333-444444444444";
  const dir = path.join(home, "sessions", encodeCwdForGrok("/tmp/x"), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "updates.jsonl"),
    [userChunk(sid, "go"), agentChunk(sid, "Let me check."), toolCall(sid, "t1", "Run"), toolCallDone(sid, "t1"), turnCompleted(sid)].join("\n") + "\n",
  );
  expect(grokTurnFromUpdates(fs.readFileSync(path.join(dir, "updates.jsonl"), "utf8")).text).toBe("");
  await expect(waitForGrokReply(sid, 0, { graceMs: 50, pollMs: 10 })).rejects.toThrow(
    /GROK_TURN|tool call with no final reply text/,
  );
  try {
    await waitForGrokReply(sid, 0, { graceMs: 50, pollMs: 10 });
  } catch (err: any) {
    expect(err.code).toBe("GROK_TURN");
    expect(err.message).toContain("tool call with no final reply text");
  }
});

test("two quick prompts in one session: each read binds to its own turn, never mixed", () => {
  const jsonl = [
    ...turnLines(SID, "first\nmsg", MULTILINE_REPLY, 0),
    ...turnLines(SID, "second msg", LONG_CHINESE_REPLY, 1),
  ].join("\n");
  expect(grokTurnFromUpdates(jsonl, { prompt: "first\r\nmsg" }).text).toBe(MULTILINE_REPLY);
  expect(grokTurnFromUpdates(jsonl, { prompt: "second msg" }).text).toBe(LONG_CHINESE_REPLY);
  // Second turn not written yet → its read is pending, not the first turn's text.
  const onlyFirst = turnLines(SID, "first\nmsg", MULTILINE_REPLY, 0).join("\n");
  expect(grokTurnFromUpdates(onlyFirst + "\n" + userChunk(SID, "second msg"), { prompt: "second msg" })).toMatchObject({
    text: "",
    completed: false,
  });
  expect(grokTurnFromUpdates(onlyFirst, { prompt: "second msg" }).completed).toBe(false);
});
