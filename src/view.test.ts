import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MEMBER_NAMES } from "./types.ts";
import { createChannel, postToChannel, resumeDefaultTeam } from "./store.ts";
import { chatView } from "./view.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-bot-view-"));
  process.env.HERDR_BOT_STATE_DIR = dir;
  process.env.HERDR_BOT_BODIES = "pi,omp";
});

afterEach(() => {
  delete process.env.HERDR_BOT_STATE_DIR;
  delete process.env.HERDR_BOT_BODIES;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("default team sidebar is exactly the four default names", () => {
  const team = resumeDefaultTeam();
  const view = chatView(team, { kind: "bot", index: 0 });
  expect(view.sidebarBots).toEqual([...DEFAULT_MEMBER_NAMES]);
  expect(view.sidebarBots).toHaveLength(4);
});

test("selecting 幕僚长 is a 1:1 DM, never the profile description", () => {
  const team = resumeDefaultTeam();
  const view = chatView(team, { kind: "bot", index: 0 });
  expect(view.kind).toBe("dm");
  expect(view.header).toBe("幕僚长");
  expect(view.showingProfile).toBe(false);
  expect(view.thread.join("\n")).not.toContain("管理你的其他 Bot");
});

test("selecting #standup shows the four known posts in order", () => {
  resumeDefaultTeam();
  createChannel({ name: "standup" });
  postToChannel("standup", "lead", "herdr-bot ping: reply in this pane.");
  postToChannel("standup", "eng", "收到，herdr-bot 在线。");
  postToChannel("standup", "research", "herdr-bot pong 🏓");
  postToChannel("standup", "qa", "pong 🏓");
  const team = resumeDefaultTeam();
  const view = chatView(team, { kind: "channel", index: 0 });
  expect(view.kind).toBe("channel");
  expect(view.header).toBe("#standup");
  expect(view.showingProfile).toBe(false);
  expect(view.sidebarChannels).toEqual(["#standup"]);
  expect(view.thread).toEqual([
    "幕僚长: herdr-bot ping: reply in this pane.",
    "研发工程师: 收到，herdr-bot 在线。",
    "研究员: herdr-bot pong 🏓",
    "测试工程师: pong 🏓",
  ]);
});
