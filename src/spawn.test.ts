import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MEMBER_NAMES, DEFAULT_SEED_BOTS, USER_ID } from "./types.ts";
import {
  BOTS_TAB_LABEL,
  CHANNEL_SESSION_HINT,
  IM_SESSION_HINT,
  PANE_CH,
  PANE_IM,
  PANE_WORK,
  agentSlug,
  chAgentSlug,
  deliverChannelPost,
  ensureTeamLive,
  formatChannelPrompt,
  formatDmPrompt,
  identitySystemPrompt,
  imAgentSlug,
  listLiveBots,
  openBot,
  openBotsTui,
  replyTextFromPromptResult,
  replyTextFromSessionRead,
  sendComposer,
  sessionSystemPrompt,
  setHerdrRunner,
} from "./spawn.ts";
import { getDm, loadOrSeedDefaultTeam, postToChannel, resumeDefaultTeam, setBotDescription } from "./store.ts";

let dir: string;
let calls: string[][];
let workspaces: any[];
let tabs: any[];
let panes: any[];
let agents: any[];
let seq: number;
let promptIncludeText: boolean;
let promptAgentStatus: string;
let promptTimeout: boolean;
let readDump: string | null;
let startBusySlugs: Set<string>;

const WORK_SLUGS = ["lead", "eng", "research", "qa"];

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
  promptIncludeText = true;
  promptAgentStatus = "done";
  promptTimeout = false;
  readDump = null;
  startBusySlugs = new Set();
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
    if (args[0] === "pane" && args[1] === "split") {
      const parentId = args[2];
      const parent = panes.find((x) => x.pane_id === parentId);
      seq++;
      const pane = {
        pane_id: `wHB:p${seq}`,
        workspace_id: "wHB",
        tab_id: parent?.tab_id,
        label: undefined,
        agent_status: "unknown",
      };
      panes.push(pane);
      return ok({ type: "pane_info", pane });
    }
    if (args[0] === "pane" && args[1] === "process-info") {
      return ok({ process_info: { foreground_processes: [] } });
    }
    if (args[0] === "pane" && args[1] === "run") {
      return ok({ ran: args[2] });
    }
    if (args[0] === "agent" && args[1] === "list") return ok({ agents });
    if (args[0] === "agent" && args[1] === "start") {
      const name = args[2];
      if (startBusySlugs.has(name)) {
        startBusySlugs.delete(name);
        return {
          stdout: "",
          stderr: JSON.stringify({ error: { code: "agent_pane_busy", message: "agent_pane_busy" } }),
          exitCode: 1,
        };
      }
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
      if (promptTimeout) {
        return { stdout: "", stderr: "timeout", exitCode: 1 };
      }
      const target = args[2];
      const payload: Record<string, unknown> = {
        type: "agent_prompted",
        agent: { name: target, agent_status: promptAgentStatus },
      };
      if (promptIncludeText) payload.text = `reply from ${target}`;
      return ok(payload);
    }
    if (args[0] === "agent" && args[1] === "read") {
      if (readDump != null) {
        return { stdout: readDump, stderr: "", exitCode: 0 };
      }
      return ok({});
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

function starts(): string[][] {
  return calls.filter((c) => c[0] === "agent" && c[1] === "start");
}

function prompts(): string[][] {
  return calls.filter((c) => c[0] === "agent" && c[1] === "prompt");
}

test("default bot ids are valid herdr agent names", () => {
  const team = resumeDefaultTeam();
  for (const bot of team.members) {
    expect(agentSlug(bot)).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(imAgentSlug(bot)).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(chAgentSlug(bot)).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  }
  expect(team.members.map(agentSlug)).toEqual(["lead", "eng", "research", "qa"]);
  expect(team.members.map(imAgentSlug)).toEqual(["lead-im", "eng-im", "research-im", "qa-im"]);
  expect(team.members.map(chAgentSlug)).toEqual(["lead-ch", "eng-ch", "research-ch", "qa-ch"]);
});

test("QA gate: ensureTeamLive puts all four default members live", async () => {
  const live = await ensureTeamLive();
  expect(live.map((m) => m.name)).toEqual([...DEFAULT_MEMBER_NAMES]);
  expect(live).toHaveLength(4);
  expect(live.every((m) => m.live)).toBe(true);
  expect(live.every((m) => m.pane_id)).toBe(true);
  expect(starts().map((c) => c[2]).sort()).toEqual(
    ["eng", "eng-ch", "eng-im", "lead", "lead-ch", "lead-im", "qa", "qa-ch", "qa-im", "research", "research-ch", "research-im"],
  );
  expect(starts().every((c) => c[c.indexOf("--kind") + 1] === "pi")).toBe(true);
});

test("QA gate: work start is identity only; IM/channel starts add a session hint", async () => {
  await ensureTeamLive();
  const all = starts();
  expect(all).toHaveLength(12);
  for (const seed of DEFAULT_SEED_BOTS) {
    const work = all.find((c) => c[2] === seed.id);
    expect(work).toBeDefined();
    const dash = work!.indexOf("--");
    expect(work!.slice(dash, dash + 3)).toEqual(["--", "--system-prompt", identitySystemPrompt(seed)]);
    expect(work![dash + 2]).not.toContain(IM_SESSION_HINT);
    expect(work![dash + 2]).not.toContain(CHANNEL_SESSION_HINT);

    const im = all.find((c) => c[2] === `${seed.id}-im`);
    expect(im).toBeDefined();
    const imPrompt = im![im!.indexOf("--") + 2];
    expect(imPrompt).toBe(sessionSystemPrompt(seed, "im"));
    expect(imPrompt).toContain(seed.name);
    expect(imPrompt).toContain(IM_SESSION_HINT);

    const ch = all.find((c) => c[2] === `${seed.id}-ch`);
    expect(ch).toBeDefined();
    const chPrompt = ch![ch!.indexOf("--") + 2];
    expect(chPrompt).toBe(sessionSystemPrompt(seed, "channel"));
    expect(chPrompt).toContain(seed.name);
    expect(chPrompt).toContain(CHANNEL_SESSION_HINT);
    expect(chPrompt).toContain("#standup");
  }
});

test("identitySystemPrompt includes name, tag, and description", () => {
  for (const seed of DEFAULT_SEED_BOTS) {
    const prompt = identitySystemPrompt(seed);
    expect(prompt).toContain(seed.name);
    expect(prompt).toContain(seed.tag);
    expect(prompt).toContain(seed.description);
  }
  expect(identitySystemPrompt(DEFAULT_SEED_BOTS[0])).toBe(
    "Your name is 幕僚长. Description: 管理你的其他 Bot，需要决策时找你 Internal tag: lead (not your title; do not say this when asked who you are). When asked who you are (你是谁), answer with this exact name and the description. Never replace the name with a generic title, and never introduce yourself as the tag.",
  );
});

test("研究员 prompt uses description for 你是谁, not the tag as a title", () => {
  const seed = DEFAULT_SEED_BOTS.find((b) => b.name === "研究员")!;
  const prompt = identitySystemPrompt(seed);
  expect(prompt).toContain("Your name is 研究员");
  expect(prompt).toContain(seed.description);
  expect(prompt).toContain("GitHub");
  expect(prompt).toContain("Internal tag: research");
  expect(prompt).toContain("not your title");
  expect(prompt).toContain("never introduce yourself as the tag");
  expect(prompt).not.toMatch(/Role:\s*research/);
  expect(prompt).not.toMatch(/Your tag is research\. Role:/);
});

test("研发工程师 prompt names the bot without two competing You are identities", () => {
  const seed = DEFAULT_SEED_BOTS.find((b) => b.name === "研发工程师")!;
  const prompt = identitySystemPrompt(seed);
  expect(prompt).toContain("研发工程师");
  expect(prompt).toContain("Your name is 研发工程师");
  expect(prompt).toContain(seed.tag);
  expect(prompt).toContain(seed.description);
  expect(seed.description.startsWith("You are")).toBe(true);
  expect(prompt.startsWith("You are 研发工程师")).toBe(false);
  expect(prompt).not.toMatch(/You are 研发工程师[^\n]*You are/);
});

test("subsequent start of a not-live bot uses updated store identity", async () => {
  resumeDefaultTeam();
  setBotDescription("研发工程师", "Ships TypeScript without drama.");
  await openBot("研发工程师");
  const all = starts();
  expect(all.map((c) => c[2]).sort()).toEqual(["eng", "eng-ch", "eng-im"]);
  const work = all.find((c) => c[2] === "eng")!;
  const dash = work.indexOf("--");
  expect(work.slice(dash, dash + 3)).toEqual([
    "--",
    "--system-prompt",
    identitySystemPrompt({
      name: "研发工程师",
      tag: "eng",
      description: "Ships TypeScript without drama.",
    }),
  ]);
  expect(work[dash + 2]).toContain("研发工程师");
  expect(work[dash + 2]).toContain("Ships TypeScript without drama.");
  expect(work[dash + 2]).not.toContain("You are an awesome software engineer.");
});

test("QA gate: tab1 is bots TUI, never a member name, never 1", async () => {
  await ensureTeamLive();
  expect(["bots", "herdr-bots"]).toContain(tabs[0].label);
  expect(tabs[0].label).toBe(BOTS_TAB_LABEL);
  expect(tabs[0].label).not.toBe("1");
  expect([...DEFAULT_MEMBER_NAMES]).not.toContain(tabs[0].label);
  const creates = calls.filter((c) => c[0] === "tab" && c[1] === "create");
  expect(creates.map((c) => c[c.indexOf("--label") + 1])).toEqual([...DEFAULT_MEMBER_NAMES]);
  expect(creates).toHaveLength(4);
  expect(starts().map((c) => c[c.indexOf("--pane") + 1])).not.toContain("wHB:p1");
  const live = await listLiveBots();
  expect(live.every((m) => m.pane_id !== "wHB:p1")).toBe(true);
  for (const m of live) {
    const pane = panes.find((p) => p.pane_id === m.pane_id);
    const tab = tabs.find((t) => t.tab_id === pane?.tab_id);
    expect(tab?.label).toBe(m.name);
    expect(tab?.label).not.toBe("1");
    expect(tab?.label).not.toBe("herdr-bots");
    expect(tab?.label).not.toBe("bots");
  }
});

test("QA gate: each bot tab has work, instant-msg, and channel panes", async () => {
  await ensureTeamLive();
  for (const name of DEFAULT_MEMBER_NAMES) {
    const tab = tabs.find((t) => t.label === name);
    expect(tab).toBeDefined();
    const labels = panes.filter((p) => p.tab_id === tab.tab_id).map((p) => p.label);
    expect(labels).toContain(PANE_WORK);
    expect(labels).toContain(PANE_IM);
    expect(labels).toContain(PANE_CH);
  }
  expect(starts().some((c) => c[2] === "lead-im")).toBe(true);
  expect(starts().some((c) => c[2] === "lead-ch")).toBe(true);
  expect(starts().some((c) => c[2] === "lead")).toBe(true);
});

test("openBotsTui runs the TUI in the workspace root pane, not a bot tab", async () => {
  await ensureTeamLive();
  const before = calls.length;
  await openBotsTui();
  const after = calls.slice(before);
  const run = after.find((c) => c[0] === "pane" && c[1] === "run");
  expect(run).toBeDefined();
  expect(run![2]).toBe("wHB:p1");
  expect(run!.some((a) => String(a).includes("tui.ts"))).toBe(true);
  const overlay = after.find((c) => c[0] === "plugin" && c.includes("overlay"));
  expect(overlay).toBeUndefined();
});

test("openBot is idempotent and does not double-start", async () => {
  await ensureTeamLive();
  const before = starts().length;
  await openBot("研发工程师");
  expect(starts().length).toBe(before);
  const live = await listLiveBots();
  expect(live.find((m) => m.name === "研发工程师")?.live).toBe(true);
});

test("channel post prompts every live member channel pane except the sender, never work", async () => {
  await ensureTeamLive();
  postToChannel("standup", "lead", "hello team");
  const result = await deliverChannelPost("standup", "lead", "hello team");
  expect(result.delivered.map((m) => m.name)).toEqual(["研发工程师", "研究员", "测试工程师"]);
  expect(result.skipped).toEqual([]);
  const sent = prompts();
  expect(sent.map((c) => c[2])).toEqual(["eng-ch", "research-ch", "qa-ch"]);
  expect(sent.every((c) => c.includes("--wait") && c.includes("--timeout") && !c.includes("--until"))).toBe(true);
  expect(sent.every((c) => c[3].includes(formatChannelPrompt("standup", "幕僚长", "hello team")))).toBe(true);
  expect(sent.every((c) => c[3].includes("shared #standup"))).toBe(true);
  expect(sent.some((c) => WORK_SLUGS.includes(c[2]))).toBe(false);
});

test("channel post from user prompts every live member channel pane", async () => {
  await ensureTeamLive();
  const result = await deliverChannelPost("standup", "user", "hi everyone");
  expect(result.delivered.map((m) => m.name).sort()).toEqual([...DEFAULT_MEMBER_NAMES].sort());
  expect(result.skipped).toEqual([]);
  const sent = prompts();
  expect(sent.map((c) => c[2]).sort()).toEqual(["eng-ch", "lead-ch", "qa-ch", "research-ch"]);
  expect(sent.every((c) => c.includes("--wait") && c.includes("--timeout") && !c.includes("--until"))).toBe(true);
  expect(sent.every((c) => c[3].includes(formatChannelPrompt("standup", "Phoobobo", "hi everyone")))).toBe(true);
  expect(sent.some((c) => WORK_SLUGS.includes(c[2]))).toBe(false);
});

test("sendComposer on a bot posts a DM as user and prompts that IM agent with --wait", async () => {
  resumeDefaultTeam();
  const msg = await sendComposer({ kind: "bot", index: 0 }, "hello lead");
  expect(msg).not.toBeNull();
  expect(msg!.from_bot_id).toBe(USER_ID);
  expect(msg!.text).toBe("hello lead");
  const reloaded = loadOrSeedDefaultTeam();
  const dm = getDm(reloaded, "lead");
  expect(dm.map((m) => `${m.from_bot_id}: ${m.text}`)).toEqual([
    "user: hello lead",
    "lead: reply from lead-im",
  ]);
  const sent = prompts();
  expect(sent.some((c) => c[2] === "lead-im" && c[3] === formatDmPrompt("hello lead") && c.includes("--wait"))).toBe(true);
  expect(sent.every((c) => c.includes("--wait") && c.includes("--timeout"))).toBe(true);
  expect(sent.every((c) => !c.includes("--until"))).toBe(true);
  expect(sent.some((c) => c[2] === "lead")).toBe(false);
  expect(calls.filter((c) => c[0] === "agent" && c[1] === "read")).toEqual([]);
});

test("sendComposer DM to 研发工程师 prompts eng-im --wait, never work slug eng", async () => {
  resumeDefaultTeam();
  await sendComposer({ kind: "bot", index: 1 }, "hello eng");
  const sent = prompts();
  expect(sent.map((c) => c[2])).toEqual(["eng-im"]);
  expect(sent[0].includes("--wait")).toBe(true);
  expect(sent[0].includes("--timeout")).toBe(true);
  expect(sent[0].includes("--until")).toBe(false);
  expect(sent.some((c) => c[2] === "eng")).toBe(false);
  const dm = getDm("eng");
  expect(dm.some((m) => m.from_bot_id === "eng" && m.text === "reply from eng-im")).toBe(true);
  expect(calls.filter((c) => c[0] === "agent" && c[1] === "read")).toEqual([]);
});

test("sendComposer on a channel posts as user, prompts all *-ch with --wait, never work", async () => {
  await ensureTeamLive();
  const before = prompts().length;
  const msg = await sendComposer({ kind: "channel", index: 0 }, "hi team");
  expect(msg).not.toBeNull();
  expect(msg!.from_bot_id).toBe(USER_ID);
  expect(msg!.text).toBe("hi team");
  const reloaded = loadOrSeedDefaultTeam();
  expect(reloaded.channels.map((c) => c.name)).toEqual(["standup"]);
  expect(reloaded.channels).toHaveLength(1);
  expect(reloaded.channels[0].messages[0].from_bot_id).toBe("user");
  expect(reloaded.channels[0].messages[0].text).toBe("hi team");
  const sent = prompts().slice(before);
  expect(sent.map((c) => c[2])).toEqual(["lead-ch", "eng-ch", "research-ch", "qa-ch"]);
  expect(sent.every((c) => c.includes("--wait"))).toBe(true);
  expect(sent.every((c) => c.includes("--timeout"))).toBe(true);
  expect(sent.every((c) => !c.includes("--until"))).toBe(true);
  expect(sent.some((c) => WORK_SLUGS.includes(c[2]))).toBe(false);
  expect(calls.filter((c) => c[0] === "agent" && c[1] === "read")).toEqual([]);
});

test("shared-stream gate: four channel-pane replies land in the same standup messages[] in order", async () => {
  await ensureTeamLive();
  await sendComposer({ kind: "channel", index: 0 }, "hello standup");
  const reloaded = loadOrSeedDefaultTeam();
  expect(reloaded.channels.map((c) => c.name)).toEqual(["standup"]);
  expect(reloaded.channels).toHaveLength(1);
  const ch = reloaded.channels[0];
  expect(ch.messages.map((m) => `${m.from_bot_id}: ${m.text}`)).toEqual([
    "user: hello standup",
    "lead: reply from lead-ch",
    "eng: reply from eng-ch",
    "research: reply from research-ch",
    "qa: reply from qa-ch",
  ]);
  const later = prompts().filter((c) => c[2] === "qa-ch")[0];
  expect(later[3]).toContain("幕僚长: reply from lead-ch");
  expect(later[3]).toContain("研发工程师: reply from eng-ch");
  expect(later[3]).toContain("研究员: reply from research-ch");
});

test("herdr agent_prompted JSON: reply text is result.text, not extractReplyFor", () => {
  expect(
    replyTextFromPromptResult({
      type: "agent_prompted",
      agent: { name: "lead-im", agent_status: "idle" },
      text: "pong",
    }),
  ).toBe("pong");
  expect(replyTextFromPromptResult({ type: "agent_prompted", agent: { name: "lead-im" } })).toBeNull();
  expect(
    replyTextFromPromptResult({
      type: "agent_prompted",
      agent: { name: "eng-im", agent_status: "done" },
      text: "收到：qa-im-ping-0901-a",
    }),
  ).toBe("收到：qa-im-ping-0901-a");
});

// Live herdr 0.8.2 `agent read --source recent-unwrapped --format text` of eng-im
// after the QA 1:1 ping (CLI prints .result.read.text).
const ENG_IM_READ_FIXTURE = `
 [dm] Phoobobo: qa-im-ping-0901-a


 Planning concise ping acknowledgment

 收到：qa-im-ping-0901-a

╭────────────────────────────────────────────────────────────────╮

╰────────────────────────────────────────────────────────────────╯
~/Workspace/herdr-bot (main)
↑1.2k ↓46 $0.000 (sub) 0.4%/272k (auto)        gpt-5.6-luna • high
`;

test("session read snapshot: single-line ping keeps the ack, drops thinking and Pi footer", () => {
  const prompt = formatDmPrompt("qa-im-ping-0901-a");
  expect(replyTextFromSessionRead(ENG_IM_READ_FIXTURE, prompt)).toBe("收到：qa-im-ping-0901-a");
  expect(replyTextFromSessionRead("pong", prompt)).toBe("pong");
});

// Live FAIL 2026-09-03: last wrap fragment `帮忙吗？` was stored instead of the pane sentence.
const RESEARCH_IM_READ_FIXTURE = `
 [dm] Phoobobo: 最近怎么样

 Formulating casual Chinese greeting

 挺好的，随时待命！最近有 GitHub 项目、PR 或代码需要我
 帮忙吗？

╭────────────────────────────────────────────────────────────────╮
╰────────────────────────────────────────────────────────────────╯
~/Workspace/herdr-bot (main)
↑1.2k ↓46 $0.000 (sub) 0.4%/272k (auto)        gpt-5.6-luna • high
`;

test("session read snapshot: live Chinese wrap joins CJK fragments, drops thinking, not last wrap line", () => {
  const prompt = formatDmPrompt("最近怎么样");
  expect(replyTextFromSessionRead(RESEARCH_IM_READ_FIXTURE, prompt)).toBe(
    "挺好的，随时待命！最近有 GitHub 项目、PR 或代码需要我帮忙吗？",
  );
  expect(replyTextFromSessionRead(RESEARCH_IM_READ_FIXTURE, prompt)).not.toBe("帮忙吗？");
  expect(replyTextFromSessionRead(RESEARCH_IM_READ_FIXTURE, prompt)).not.toContain("Formulating");
});

const ENG_WRAP_READ_FIXTURE = `
 [dm] Phoobobo: how are you

 Drafting a short English offer

 Sure, I can look at GitHub projects, PRs, or code if you need a hand
 Can I help?

╭────────────────────────────────────────────────────────────────╮
╰────────────────────────────────────────────────────────────────╯
~/Workspace/herdr-bot (main)
↑1.2k ↓46 $0.000 (sub) 0.4%/272k (auto)        gpt-5.6-luna • high
`;

test("session read snapshot: English wrap joins fragments, not last line Can I help?", () => {
  const prompt = formatDmPrompt("how are you");
  expect(replyTextFromSessionRead(ENG_WRAP_READ_FIXTURE, prompt)).toBe(
    "Sure, I can look at GitHub projects, PRs, or code if you need a hand Can I help?",
  );
  expect(replyTextFromSessionRead(ENG_WRAP_READ_FIXTURE, prompt)).not.toBe("Can I help?");
  expect(replyTextFromSessionRead(ENG_WRAP_READ_FIXTURE, prompt)).not.toContain("Drafting");
});

// Live FAIL 2026-09-03: pane hard-wrapped the submitted prompt, so lastIndexOf(fullPrompt)
// was -1 and the Pi v0.84.2 title bar was stored as the reply.
const PING_0903_TEXT = "qa-im-ping-0903-a，请用两句中文回复";
const PROMPT_0903 = formatDmPrompt(PING_0903_TEXT);
const SENTENCE_0903_A = "qa-im-ping-0903-a，我已收到你的消息。";
const SENTENCE_0903_B = "qa-im-ping-0903-a，我会按要求用两句中文回复。";
// Newline mid-token so the contiguous prompt substring is missing from the dump.
const PI_WRAPPED_PROMPT_FIXTURE = `
╭──────────────────────────────── Pi v0.84.2 ────────────────────────────────╮
╭────────────────────────────────────────────────────────────────╮
╰────────────────────────────────────────────────────────────────╯
 [dm] Phoobobo: qa-im-ping-
 0903-a，请用两句中文回复

 Formulating two Chinese sentences

 qa-im-ping-0903-a，我已收到你的消息。
 qa-im-ping-0903-a，我会按要求用两句中文回复。

╭────────────────────────────────────────────────────────────────╮
╰────────────────────────────────────────────────────────────────╯
~/Workspace/herdr-bot (main)
↑1.2k ↓46 $0.000 (sub) 0.4%/272k (auto)        gpt-5.6-luna • high
`;

test("session read snapshot: wrapped prompt + Pi frame yields two Chinese sentences", () => {
  expect(PROMPT_0903).toBe("[dm] Phoobobo: qa-im-ping-0903-a，请用两句中文回复");
  expect(PI_WRAPPED_PROMPT_FIXTURE.lastIndexOf(PROMPT_0903)).toBe(-1);
  expect(PI_WRAPPED_PROMPT_FIXTURE).toContain("Pi v0.84.2");
  const reply = replyTextFromSessionRead(PI_WRAPPED_PROMPT_FIXTURE, PROMPT_0903);
  expect(reply).toBe(`${SENTENCE_0903_A}\n${SENTENCE_0903_B}`);
  expect(reply).not.toContain("Pi v0.84.2");
  expect(reply).not.toContain("╭");
  expect(reply).not.toContain("╮");
  expect(reply).not.toContain("╰");
  expect(reply).not.toContain("╯");
  expect(reply).not.toContain("Formulating");
});

test("sendComposer writes the reply when wait JSON is agent_status done with text", async () => {
  promptAgentStatus = "done";
  promptIncludeText = true;
  resumeDefaultTeam();
  await sendComposer({ kind: "bot", index: 1 }, "hello eng");
  const dm = getDm("eng");
  expect(dm.some((m) => m.from_bot_id === "eng" && m.text === "reply from eng-im")).toBe(true);
  const sent = prompts();
  expect(sent[0].includes("--until")).toBe(false);
  expect(sent[0].includes("--wait")).toBe(true);
  expect(sent[0].includes("--timeout")).toBe(true);
  expect(calls.filter((c) => c[0] === "agent" && c[1] === "read")).toEqual([]);
});

test("sendComposer reads *-im snapshot when wait JSON is done with no body", async () => {
  promptAgentStatus = "done";
  promptIncludeText = false;
  readDump = ENG_IM_READ_FIXTURE;
  resumeDefaultTeam();
  await sendComposer({ kind: "bot", index: 1 }, "qa-im-ping-0901-a");
  const dm = getDm("eng");
  expect(dm.map((m) => `${m.from_bot_id}: ${m.text}`)).toEqual([
    "user: qa-im-ping-0901-a",
    "eng: 收到：qa-im-ping-0901-a",
  ]);
  const sent = prompts();
  expect(sent.map((c) => c[2])).toEqual(["eng-im"]);
  expect(sent[0].includes("--until")).toBe(false);
  const reads = calls.filter((c) => c[0] === "agent" && c[1] === "read");
  expect(reads.map((c) => c[2])).toEqual(["eng-im"]);
  expect(reads.some((c) => c[2] === "eng")).toBe(false);
});

test("sendComposer stores the full Chinese IM reply when wait JSON has no body", async () => {
  promptAgentStatus = "done";
  promptIncludeText = false;
  readDump = RESEARCH_IM_READ_FIXTURE;
  resumeDefaultTeam();
  await sendComposer({ kind: "bot", index: 2 }, "最近怎么样");
  const dm = getDm("research");
  expect(dm.map((m) => `${m.from_bot_id}: ${m.text}`)).toEqual([
    "user: 最近怎么样",
    "research: 挺好的，随时待命！最近有 GitHub 项目、PR 或代码需要我帮忙吗？",
  ]);
  const reads = calls.filter((c) => c[0] === "agent" && c[1] === "read");
  expect(reads.map((c) => c[2])).toEqual(["research-im"]);
});

test("sendComposer stores two Chinese sentences from wrapped-prompt snapshot, not Pi frame", async () => {
  promptAgentStatus = "done";
  promptIncludeText = false;
  readDump = PI_WRAPPED_PROMPT_FIXTURE;
  resumeDefaultTeam();
  await sendComposer({ kind: "bot", index: 2 }, PING_0903_TEXT);
  const dm = getDm("research");
  expect(dm.map((m) => `${m.from_bot_id}: ${m.text}`)).toEqual([
    `user: ${PING_0903_TEXT}`,
    `research: ${SENTENCE_0903_A}\n${SENTENCE_0903_B}`,
  ]);
  expect(dm[1].text).not.toContain("Pi v0.84.2");
  expect(dm[1].text).not.toContain("╭");
  const reads = calls.filter((c) => c[0] === "agent" && c[1] === "read");
  expect(reads.map((c) => c[2])).toEqual(["research-im"]);
});

test("sendComposer reads socket JSON .read.text when wait JSON has no body", async () => {
  promptAgentStatus = "done";
  promptIncludeText = false;
  readDump = JSON.stringify({
    id: "cli:agent:read",
    result: { read: { text: ENG_IM_READ_FIXTURE } },
  }) + "\n";
  resumeDefaultTeam();
  await sendComposer({ kind: "bot", index: 1 }, "qa-im-ping-0901-a");
  const dm = getDm("eng");
  expect(dm.some((m) => m.from_bot_id === "eng" && m.text === "收到：qa-im-ping-0901-a")).toBe(true);
});

test("prompt --wait timeout does not invent a reply", async () => {
  promptTimeout = true;
  resumeDefaultTeam();
  await expect(sendComposer({ kind: "bot", index: 1 }, "hello eng")).rejects.toThrow();
  const dm = getDm("eng");
  expect(dm.map((m) => `${m.from_bot_id}: ${m.text}`)).toEqual(["user: hello eng"]);
  expect(calls.filter((c) => c[0] === "agent" && c[1] === "read")).toEqual([]);
});

test("agent start retries agent_pane_busy on a fresh split pane", async () => {
  startBusySlugs.add("eng-im");
  await openBot("研发工程师");
  expect(agents.some((a) => a.name === "eng-im")).toBe(true);
  expect(starts().filter((c) => c[2] === "eng-im")).toHaveLength(2);
  expect(starts().filter((c) => c[2] === "eng")).toHaveLength(1);
});
