import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MEMBER_NAMES } from "./types.ts";
import { createChannel, getDm, loadOrSeedDefaultTeam, postToChannel, postToDm, resumeDefaultTeam, saveTeam } from "./store.ts";
import { chatView, clampScroll, threadLayout, threadRows, visibleRows } from "./view.ts";
import { strWidth, wrapText } from "./ui.ts";

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

// ---------------------------------------------------------------- multi-line rendering

test("wrapText keeps hard newlines (incl. blank lines) and wraps CJK by display width", () => {
  expect(wrapText("甲\n乙\n丙\n丁", 40)).toEqual(["甲", "乙", "丙", "丁"]);
  expect(wrapText("1\n2\n3", 40)).toEqual(["1", "2", "3"]);
  expect(wrapText("a\n\nb", 40)).toEqual(["a", "", "b"]);
  expect(wrapText("a\r\nb", 40)).toEqual(["a", "b"]);
  // 10 CJK chars = 20 columns → width 8 gives 4+4+2 chars, never over 8 columns.
  const rows = wrapText("一二三四五六七八九十", 8);
  expect(rows).toEqual(["一二三四", "五六七八", "九十"]);
  expect(rows.every((r) => strWidth(r) <= 8)).toBe(true);
  // odd width: a wide char never straddles the edge
  expect(wrapText("一二三", 5)).toEqual(["一二", "三"]);
  // words break at spaces when possible; nothing is dropped
  expect(wrapText("hello brave new world", 11)).toEqual(["hello brave", "new world"]);
  expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
});

test("DM thread renders 甲/乙/丙/丁 and 1/2/3 on separate rows (QA: was '甲乙丙丁', '123')", () => {
  resumeDefaultTeam();
  postToDm("lead", "user", "甲\n乙\n丙\n丁");
  postToDm("lead", "lead", "1\n2\n3");
  const view = chatView(loadOrSeedDefaultTeam(), { kind: "bot", index: 0 });
  expect(threadRows(view.entries, 60)).toEqual([
    "Phoobobo: 甲",
    "          乙",
    "          丙",
    "          丁",
    "幕僚长: 1",
    "        2",
    "        3",
  ]);
  expect(threadRows(view.entries, 60).join("")).not.toContain("…");
});

test("long replies are wrapped in full, never truncated with …, and the thread scrolls", () => {
  resumeDefaultTeam();
  const long = "这是一段很长的中文回复，用来确认对话区不会截断。".repeat(12);
  postToDm("lead", "lead", long);
  const view = chatView(loadOrSeedDefaultTeam(), { kind: "bot", index: 0 });
  const width = 30;
  const rows = threadRows(view.entries, width);
  expect(rows.length).toBeGreaterThan(10);
  expect(rows.every((r) => strWidth(r) <= width)).toBe(true);
  expect(rows.join("")).not.toContain("…");
  const prefix = "幕僚长: ";
  const indent = " ".repeat(strWidth(prefix));
  const rebuilt = rows.map((r, i) => (i === 0 ? r.slice(prefix.length) : r.slice(indent.length))).join("");
  expect(rebuilt).toBe(long);

  // viewport: pinned to newest by default; scrolling reveals earlier rows, clamped
  const h = 5;
  expect(visibleRows(rows, h, 0)).toEqual(rows.slice(-h));
  expect(visibleRows(rows, h, 3)).toEqual(rows.slice(-h - 3, -3));
  expect(clampScroll(10_000, rows.length, h)).toBe(rows.length - h);
  expect(visibleRows(rows, h, 10_000)).toEqual(rows.slice(0, h));
  expect(clampScroll(-4, rows.length, h)).toBe(0);
});

// ---------------------------------------------------------------- reply_to rendering

test("Q,Q,A,A: a reply not directly under its question is labelled with the question", () => {
  resumeDefaultTeam();
  const q1 = postToDm("eng", "user", "message one");
  const q2 = postToDm("eng", "user", "message two\nsecond line");
  postToDm("eng", "eng", "answer one", { reply_to: q1.id });
  postToDm("eng", "eng", "answer two", { reply_to: q2.id });
  const view = chatView(loadOrSeedDefaultTeam(), { kind: "bot", index: 1 });
  expect(view.entries.map((e) => e.reply_to ?? null)).toEqual([null, null, q1.id, q2.id]);
  const layout = threadLayout(view.entries, 60);
  expect(layout.map((r) => r.text)).toEqual([
    "Phoobobo: message one",
    "Phoobobo: message two",
    "          second line",
    "↳ re Phoobobo: message one",
    "研发工程师: answer one",
    "↳ re Phoobobo: message two",
    "研发工程师: answer two",
  ]);
  expect(layout.filter((r) => r.label).map((r) => r.text)).toEqual([
    "↳ re Phoobobo: message one",
    "↳ re Phoobobo: message two",
  ]);
});

test("in-order replies (and channel fan-out to one post) need no label; old records render plain", () => {
  resumeDefaultTeam();
  const q = postToDm("lead", "user", "hi");
  postToDm("lead", "lead", "hello", { reply_to: q.id });
  createChannel({ name: "standup" });
  const post = postToChannel("standup", "user", "standup?");
  for (const b of ["lead", "eng", "research", "qa"]) postToChannel("standup", b, `${b} ok`, { reply_to: post.id });
  // legacy: a reply stored before reply_to existed, plus one pointing at a missing id
  const team = loadOrSeedDefaultTeam();
  team.dms!.lead.push({ id: "msg_old", from_bot_id: "lead", text: "old reply", created_at: 1 });
  team.dms!.lead.push({ id: "msg_x", from_bot_id: "lead", text: "orphan", created_at: 2, reply_to: "msg_gone" });
  saveTeam(team);
  expect(getDm("lead")).toHaveLength(4);
  const t2 = loadOrSeedDefaultTeam();
  const dm = threadRows(chatView(t2, { kind: "bot", index: 0 }).entries, 60);
  expect(dm).toEqual([
    "Phoobobo: hi",
    "幕僚长: hello",
    "幕僚长: old reply",
    "↳ re: (earlier message not found)",
    "幕僚长: orphan",
  ]);
  const ch = threadRows(chatView(t2, { kind: "channel", index: 0 }).entries, 60);
  expect(ch.some((r) => r.startsWith("↳"))).toBe(false);
  expect(ch).toHaveLength(5);
});
