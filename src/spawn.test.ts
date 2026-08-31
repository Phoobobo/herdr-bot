import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MEMBER_NAMES } from "./types.ts";
import { resumeDefaultTeam } from "./store.ts";
import { USER_ID } from "./types.ts";
import { agentSlug, deliverChannelPost, ensureTeamLive, formatChannelPrompt, formatDmPrompt, listLiveBots, openBot, sendComposer, setHerdrRunner } from "./spawn.ts";
import { createChannel, getDm, loadOrSeedDefaultTeam, postToChannel } from "./store.ts";

let dir: string;
let calls: string[][];
let workspaces: any[];
let tabs: any[];
let panes: any[];
let agents: any[];
let seq: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-bot-spawn-"));
  process.env.HERDR_BOT_STATE_DIR = dir;
  process.env.HERDR_BOT_BODIES = "pi,omp,claude,codex,grok";
  calls = [];
  workspaces = [];
  tabs = [];
  panes = [];
  agents = [];
  seq = 0;
  setHerdrRunner(async (args) => {
    calls.push(args);
    const cmd = args.join(" ");
    const ok = (result: unknown) => ({
      stdout: JSON.stringify({ id: "cli", result }) + "\n",
      stderr: "",
      exitCode: 0,
    });
    if (cmd === "workspace list") return ok({ workspaces });
    if (args[0] === "workspace" && args[1] === "create") {
      seq++;
      const ws = { workspace_id: `wHB`, label: "herdr-bots" };
      workspaces.push(ws);
      const pane = {
        pane_id: `wHB:p1`,
        workspace_id: "wHB",
        tab_id: "wHB:t1",
        label: undefined,
        agent_status: "unknown",
      };
      panes.push(pane);
      tabs.push({ tab_id: "wHB:t1", label: "herdr-bots", workspace_id: "wHB" });
      return ok({ workspace: ws, tab: { tab_id: "wHB:t1" }, root_pane: { pane_id: "wHB:p1" } });
    }
    if (args[0] === "tab" && args[1] === "list") return ok({ tabs });
    if (args[0] === "tab" && args[1] === "create") {
      const label = args[args.indexOf("--label") + 1];
      seq++;
      const tab_id = `wHB:t${seq}`;
      const pane_id = `wHB:p${seq}`;
      tabs.push({ tab_id, label, workspace_id: "wHB" });
      panes.push({ pane_id, workspace_id: "wHB", tab_id, label, agent_status: "unknown" });
      return ok({ tab: { tab_id }, root_pane: { pane_id } });
    }
    if (cmd === "pane list" || (args[0] === "pane" && args[1] === "list")) return ok({ panes });
    if (args[0] === "agent" && args[1] === "list") return ok({ agents });
    if (args[0] === "agent" && args[1] === "start") {
      const name = args[2];
      const kind = args[args.indexOf("--kind") + 1];
      const pane = args[args.indexOf("--pane") + 1];
      agents.push({ name, agent: kind, pane_id: pane, agent_status: "idle" });
      const p = panes.find((x) => x.pane_id === pane);
      if (p) {
        p.agent = kind;
        p.agent_status = "idle";
        p.label = name;
      }
      return ok({ name, pane_id: pane });
    }
    if (args[0] === "agent" && args[1] === "prompt") {
      return ok({ prompted: args[2] });
    }
    if (args[0] === "tab" && args[1] === "rename") {
      const t = tabs.find((x) => x.tab_id === args[2]);
      if (t) t.label = args.slice(3).join(" ");
      return ok({});
    }
    if (args[0] === "pane" && (args[1] === "rename" || args[1] === "report-metadata" || args[1] === "focus")) {
      if (args[1] === "rename") {
        const p = panes.find((x) => x.pane_id === args[2]);
        if (p) p.label = args[3];
      }
      return ok({});
    }
    return ok({});
  });
});

afterEach(() => {
  setHerdrRunner(null);
  delete process.env.HERDR_BOT_STATE_DIR;
  delete process.env.HERDR_BOT_BODIES;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("default bot ids are valid herdr agent names", () => {
  const team = resumeDefaultTeam();
  for (const bot of team.members) {
    expect(agentSlug(bot)).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  }
  expect(team.members.map(agentSlug)).toEqual(["lead", "eng", "research", "qa"]);
});

test("QA gate: ensureTeamLive puts all four default members live", async () => {
  const live = await ensureTeamLive();
  expect(live.map((m) => m.name)).toEqual([...DEFAULT_MEMBER_NAMES]);
  expect(live).toHaveLength(4);
  expect(live.every((m) => m.live)).toBe(true);
  expect(live.every((m) => m.pane_id)).toBe(true);
  const starts = calls.filter((c) => c[0] === "agent" && c[1] === "start");
  expect(starts.map((c) => c[2])).toEqual(["lead", "eng", "research", "qa"]);
  expect(starts.every((c) => c[c.indexOf("--kind") + 1] === "pi")).toBe(true);
});

test("QA gate: each bot gets a dedicated named tab, never workspace root pane", async () => {
  const live = await ensureTeamLive();
  const creates = calls.filter((c) => c[0] === "tab" && c[1] === "create");
  expect(creates.map((c) => c[c.indexOf("--label") + 1])).toEqual([...DEFAULT_MEMBER_NAMES]);
  expect(creates).toHaveLength(4);
  const starts = calls.filter((c) => c[0] === "agent" && c[1] === "start");
  const startPanes = starts.map((c) => c[c.indexOf("--pane") + 1]);
  expect(startPanes).not.toContain("wHB:p1");
  expect(live.every((m) => m.pane_id !== "wHB:p1")).toBe(true);
  for (const m of live) {
    const pane = panes.find((p) => p.pane_id === m.pane_id);
    const tab = tabs.find((t) => t.tab_id === pane?.tab_id);
    expect(tab?.label).toBe(m.name);
    expect(tab?.label).not.toBe("1");
    expect(tab?.label).not.toBe("herdr-bots");
    expect(tab?.label).toBeDefined();
  }
  const renames = calls.filter((c) => c[0] === "tab" && c[1] === "rename");
  expect(renames.map((c) => c.slice(3).join(" "))).toEqual([...DEFAULT_MEMBER_NAMES]);
});

test("openBot is idempotent and does not double-start", async () => {
  await ensureTeamLive();
  const before = calls.filter((c) => c[0] === "agent" && c[1] === "start").length;
  await openBot("研发工程师");
  const after = calls.filter((c) => c[0] === "agent" && c[1] === "start").length;
  expect(after).toBe(before);
  const live = await listLiveBots();
  expect(live.find((m) => m.name === "研发工程师")?.live).toBe(true);
});

test("channel post prompts every live member except the sender", async () => {
  await ensureTeamLive();
  createChannel({ name: "standup" });
  postToChannel("standup", "lead", "hello team");
  const result = await deliverChannelPost("standup", "lead", "hello team");
  expect(result.delivered.map((m) => m.name)).toEqual(["研发工程师", "研究员", "测试工程师"]);
  expect(result.skipped).toEqual([]);
  const prompts = calls.filter((c) => c[0] === "agent" && c[1] === "prompt");
  expect(prompts.map((c) => c[2])).toEqual(["eng", "research", "qa"]);
  const text = formatChannelPrompt("standup", "幕僚长", "hello team");
  expect(prompts.every((c) => c[3] === text)).toBe(true);
  expect(prompts.some((c) => c[2] === "lead")).toBe(false);
});

test("channel post from user prompts every live member", async () => {
  await ensureTeamLive();
  createChannel({ name: "standup" });
  const result = await deliverChannelPost("standup", "user", "hi everyone");
  expect(result.delivered.map((m) => m.name).sort()).toEqual([...DEFAULT_MEMBER_NAMES].sort());
  expect(result.skipped).toEqual([]);
  const prompts = calls.filter((c) => c[0] === "agent" && c[1] === "prompt");
  expect(prompts.map((c) => c[2]).sort()).toEqual(["eng", "lead", "qa", "research"]);
  const body = formatChannelPrompt("standup", "Phoobobo", "hi everyone");
  expect(prompts.every((c) => c[3] === body)).toBe(true);
});

test("sendComposer on a bot posts a DM as user and prompts that agent", async () => {
  resumeDefaultTeam();
  const msg = await sendComposer({ kind: "bot", index: 0 }, "hello lead");
  expect(msg).not.toBeNull();
  expect(msg!.from_bot_id).toBe(USER_ID);
  expect(msg!.text).toBe("hello lead");
  const reloaded = loadOrSeedDefaultTeam();
  const dm = getDm(reloaded, "lead");
  expect(dm).toHaveLength(1);
  expect(dm[0].from_bot_id).toBe("user");
  expect(dm[0].text).toBe("hello lead");
  const prompts = calls.filter((c) => c[0] === "agent" && c[1] === "prompt");
  expect(prompts.some((c) => c[2] === "lead" && c[3] === formatDmPrompt("hello lead"))).toBe(true);
});

test("sendComposer on a channel posts as user and delivers to live members", async () => {
  await ensureTeamLive();
  createChannel({ name: "standup" });
  const before = calls.filter((c) => c[0] === "agent" && c[1] === "prompt").length;
  const msg = await sendComposer({ kind: "channel", index: 0 }, "hi team");
  expect(msg).not.toBeNull();
  expect(msg!.from_bot_id).toBe(USER_ID);
  expect(msg!.text).toBe("hi team");
  const reloaded = loadOrSeedDefaultTeam();
  expect(reloaded.channels[0].messages[0].from_bot_id).toBe("user");
  expect(reloaded.channels[0].messages[0].text).toBe("hi team");
  const prompts = calls.filter((c) => c[0] === "agent" && c[1] === "prompt").slice(before);
  expect(prompts.map((c) => c[2]).sort()).toEqual(["eng", "lead", "qa", "research"]);
  const body = formatChannelPrompt("standup", "Phoobobo", "hi team");
  expect(prompts.every((c) => c[3] === body)).toBe(true);
});
