import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChannel, postToChannel, resumeDefaultTeam } from "./store.ts";
import { extractReplyFor, setPaneReader, syncChannelReplies, threadLines } from "./thread.ts";

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
  process.env.HERDR_BOT_BODIES = "pi,omp";
  const panes: Record<string, string> = { lead: "", eng: ENG, research: RESEARCH, qa: QA };
  setPaneReader(async (slug) => panes[slug] ?? "");
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
