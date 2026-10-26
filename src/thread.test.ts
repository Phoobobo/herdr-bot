import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChannel, getDm, postToChannel, postToDm, resumeDefaultTeam, setBody } from "./store.ts";
import { extractReplyFor, setPaneReader, syncChannelReplies, syncDmReplies, threadLines } from "./thread.ts";

const ENG = `
 [#standup] 幕僚长: herdr-bot ping: reply in this pane.

 Preparing acknowledgment reply

 [#standup] 幕僚长: 收到，herdr-bot 在线。
`;

const RESEARCH = `
 [#standup] 幕僚长: herdr-bot ping: reply in this pane.

 Planning simple pong reply

 herdr-bot pong 🏓
`;

const QA = `
 [#standup] 幕僚长: herdr-bot ping: reply in this pane.

 Formulating in-pane pong reply

 pong 🏓
`;

test("extracts the reply after an inbound channel prompt", () => {
  expect(extractReplyFor(ENG, "standup", "幕僚长", "herdr-bot ping: reply in this pane.")).toBe(
    "收到，herdr-bot 在线。",
  );
  expect(extractReplyFor(RESEARCH, "standup", "幕僚长", "herdr-bot ping: reply in this pane.")).toBe(
    "herdr-bot pong 🏓",
  );
  expect(extractReplyFor(QA, "standup", "幕僚长", "herdr-bot ping: reply in this pane.")).toBe("pong 🏓");
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-bot-thread-"));
  process.env.HERDR_BOT_STATE_DIR = dir;
  process.env.HERDR_BOT_BODIES = "pi,omp,grok";
  const panes: Record<string, string> = { lead: "", eng: ENG, research: RESEARCH, qa: QA };
  setPaneReader(async (slug) => panes[slug] ?? "");
  // Screen sync is the pi-body path; grok bodies are skipped (see last test).
  for (const b of resumeDefaultTeam().members) setBody(b.id, "pi");
});

afterEach(() => {
  setPaneReader(null);
  delete process.env.HERDR_BOT_STATE_DIR;
  delete process.env.HERDR_BOT_BODIES;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("QA gate: overlay thread matches eng/research/qa pane replies", async () => {
  resumeDefaultTeam();
  createChannel({ name: "standup" });
  postToChannel("standup", "lead", "herdr-bot ping: reply in this pane.");
  const { channel, added } = await syncChannelReplies("standup");
  expect(added.map((a) => a.from)).toEqual(["研发工程师", "研究员", "测试工程师"]);
  const team = resumeDefaultTeam();
  const lines = threadLines(team, channel);
  expect(lines[0]).toBe("幕僚长: herdr-bot ping: reply in this pane.");
  expect(lines).toContain("研发工程师: 收到，herdr-bot 在线。");
  expect(lines).toContain("研究员: herdr-bot pong 🏓");
  expect(lines).toContain("测试工程师: pong 🏓");
  expect(lines).toHaveLength(4);
});

test("sync is idempotent", async () => {
  resumeDefaultTeam();
  createChannel({ name: "standup" });
  postToChannel("standup", "lead", "herdr-bot ping: reply in this pane.");
  await syncChannelReplies("standup");
  const again = await syncChannelReplies("standup");
  expect(again.added).toEqual([]);
  expect(again.channel.messages).toHaveLength(4);
});

test("syncDmReplies pulls the bot reply after a user DM", async () => {
  const pane = `
 [dm] Phoobobo: ping

 Planning reply

 pong from lead
`;
  setPaneReader(async (slug) => (slug === "lead" ? pane : ""));
  resumeDefaultTeam();
  postToDm("lead", "user", "ping");
  const { added } = await syncDmReplies("lead");
  expect(added.map((a) => a.text)).toEqual(["pong from lead"]);
  const dm = getDm("lead");
  expect(dm.map((m) => `${m.from_bot_id}: ${m.text}`)).toEqual(["user: ping", "lead: pong from lead"]);
});

test("user channel posts are outbound for sync", async () => {
  const eng = `
 [#standup] Phoobobo: hello everyone

 Preparing acknowledgment reply

 收到
`;
  setPaneReader(async (slug) => (slug === "eng" ? eng : ""));
  resumeDefaultTeam();
  createChannel({ name: "standup" });
  postToChannel("standup", "user", "hello everyone");
  const { added } = await syncChannelReplies("standup");
  expect(added.map((a) => a.from)).toContain("研发工程师");
  expect(added.find((a) => a.from === "研发工程师")?.text).toBe("收到");
});

test("shared-stream gate: one standup channel holds every member reply in order", () => {
  resumeDefaultTeam();
  createChannel({ name: "standup" });
  postToChannel("standup", "user", "hello");
  postToChannel("standup", "lead", "a");
  postToChannel("standup", "eng", "b");
  postToChannel("standup", "research", "c");
  postToChannel("standup", "qa", "d");
  const team = resumeDefaultTeam();
  expect(team.channels.map((c) => c.name)).toEqual(["standup"]);
  expect(team.channels).toHaveLength(1);
  expect(threadLines(team, team.channels[0])).toEqual([
    "Phoobobo: hello",
    "幕僚长: a",
    "研发工程师: b",
    "研究员: c",
    "测试工程师: d",
  ]);
});

test("grok bodies are never screen-synced (write-back comes from grok's session log)", async () => {
  for (const b of resumeDefaultTeam().members) setBody(b.id, "grok");
  createChannel({ name: "standup" });
  postToChannel("standup", "lead", "herdr-bot ping: reply in this pane.");
  const { added } = await syncChannelReplies("standup");
  expect(added).toEqual([]);
  postToDm("eng", "user", "ping");
  expect((await syncDmReplies("eng")).added).toEqual([]);
});
