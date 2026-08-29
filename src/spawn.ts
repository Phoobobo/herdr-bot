// Open a bot = start its body as a live harness in the default Herdr session.
// One team workspace (`herdr-bots`); one tab per bot; `herdr agent start`.

import * as store from "./store.ts";
import { runHerdr } from "./herdr.ts";
import {
  BotError,
  DEFAULT_MEMBER_NAMES,
  DEFAULT_SESSION,
  type Bot,
  type Team,
} from "./types.ts";

export type RunResult = { stdout: string; stderr: string; exitCode: number };
export type HerdrRunner = (args: string[]) => Promise<RunResult>;

const WORKSPACE_LABEL = "herdr-bots";
const CWD = "/Users/phoobobo/Workspace/herdr-bot";

let runner: HerdrRunner = (args) => runHerdr(args);

export function setHerdrRunner(next: HerdrRunner | null): void {
  runner = next ?? ((args) => runHerdr(args));
}

export function agentSlug(bot: Pick<Bot, "id" | "name">): string {
  if (/^[a-z][a-z0-9_-]{0,31}$/.test(bot.id)) return bot.id;
  throw new BotError("BAD_REQUEST", `bot id is not a valid herdr agent name: ${bot.id}`);
}

function unwrap(stdout: string): any {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"));
  if (!lines.length) return {};
  const msg = JSON.parse(lines[lines.length - 1]);
  return msg.result ?? msg;
}

async function herdrJson(args: string[]): Promise<any> {
  const res = await runner(args);
  if (res.exitCode !== 0) {
    const err = (res.stderr || res.stdout).trim() || `${args.join(" ")} failed (${res.exitCode})`;
    throw new BotError("HERDR", err);
  }
  try {
    return unwrap(res.stdout);
  } catch {
    return {};
  }
}

export interface LiveMember {
  name: string;
  slug: string;
  body: string;
  pane_id: string | null;
  status: string | null;
  live: boolean;
}

function defaultBots(team: Team): Bot[] {
  return DEFAULT_MEMBER_NAMES.map((name) => {
    const bot = team.members.find((b) => b.name === name);
    if (!bot) throw new BotError("BOT_NOT_FOUND", `default member missing: ${name}`);
    return bot;
  });
}

async function agentList(): Promise<any[]> {
  const r = await herdrJson(["agent", "list"]);
  return r.agents ?? [];
}

async function paneList(): Promise<any[]> {
  const r = await herdrJson(["pane", "list"]);
  return r.panes ?? [];
}

async function workspaceList(): Promise<any[]> {
  const r = await herdrJson(["workspace", "list"]);
  return r.workspaces ?? [];
}

function agentName(a: any): string {
  return String(a.name ?? a.agent_name ?? "");
}

function findLive(bot: Bot, agents: any[], panes: any[]): { pane_id: string; status: string } | null {
  const slug = agentSlug(bot);
  const named = agents.find((a) => agentName(a) === slug);
  if (named?.pane_id) {
    return { pane_id: named.pane_id, status: named.agent_status ?? "unknown" };
  }
  if (bot.pane_id) {
    const pane = panes.find((p) => p.pane_id === bot.pane_id);
    if (pane && pane.agent && pane.agent_status && pane.agent_status !== "unknown") {
      return { pane_id: pane.pane_id, status: pane.agent_status };
    }
  }
  const labeled = panes.find(
    (p) => p.label === bot.name && p.agent && p.agent_status && p.agent_status !== "unknown",
  );
  if (labeled) return { pane_id: labeled.pane_id, status: labeled.agent_status };
  return null;
}

async function ensureWorkspace(team: Team): Promise<string> {
  const spaces = await workspaceList();
  const existing =
    (team.workspace_id && spaces.find((w) => w.workspace_id === team.workspace_id)) ||
    spaces.find((w) => w.label === WORKSPACE_LABEL || String(w.label ?? "").endsWith(WORKSPACE_LABEL));
  if (existing) {
    team.workspace_id = existing.workspace_id;
    store.saveTeam(team);
    return existing.workspace_id;
  }
  const created = await herdrJson([
    "workspace",
    "create",
    "--cwd",
    CWD,
    "--label",
    WORKSPACE_LABEL,
    "--no-focus",
  ]);
  const id = created.workspace?.workspace_id ?? created.workspace_id;
  if (!id) throw new BotError("HERDR", "workspace.create returned no workspace_id");
  team.workspace_id = id;
  const paneId = created.root_pane?.pane_id ?? created.workspace?.root_pane?.pane_id;
  const first = defaultBots(team)[0];
  if (first && paneId && !first.pane_id) first.pane_id = paneId;
  store.saveTeam(team);
  return id;
}

async function tabPanes(workspaceId: string): Promise<any[]> {
  const r = await herdrJson(["tab", "list", "--workspace", workspaceId]);
  return r.tabs ?? [];
}

async function ensurePane(team: Team, bot: Bot, workspaceId: string): Promise<string> {
  const tabs = await tabPanes(workspaceId);
  const tab = tabs.find((t) => t.label === bot.name);
  if (tab) {
    const panes = await paneList();
    const inTab = panes.find((p) => p.tab_id === tab.tab_id && p.workspace_id === workspaceId);
    if (inTab) return inTab.pane_id;
    if (tab.root_pane_id) return tab.root_pane_id;
  }
  if (bot.pane_id) {
    const panes = await paneList();
    if (panes.some((p) => p.pane_id === bot.pane_id)) return bot.pane_id;
  }
  // Reuse the workspace's first empty shell tab if this is the first bot and
  // that tab is still unlabeled / still named after the workspace.
  if (!tab) {
    const panes = await paneList();
    const unused = panes.find(
      (p) =>
        p.workspace_id === workspaceId &&
        !p.agent &&
        (p.agent_status === "unknown" || !p.agent_status) &&
        !team.members.some((m) => m.pane_id === p.pane_id && m.id !== bot.id),
    );
    if (unused) return unused.pane_id;
  }
  const created = await herdrJson([
    "tab",
    "create",
    "--workspace",
    workspaceId,
    "--cwd",
    CWD,
    "--label",
    bot.name,
    "--no-focus",
  ]);
  const paneId = created.root_pane?.pane_id ?? created.pane_id;
  if (!paneId) throw new BotError("HERDR", `tab.create returned no pane for ${bot.name}`);
  return paneId;
}

async function startHarness(bot: Bot, paneId: string): Promise<void> {
  const slug = agentSlug(bot);
  const kind = bot.body || "pi";
  await herdrJson(["agent", "start", slug, "--kind", kind, "--pane", paneId, "--timeout", "30000"]);
  await runner(["pane", "rename", paneId, bot.name]).catch(() => ({ stdout: "", stderr: "", exitCode: 0 }));
  await runner([
    "pane",
    "report-metadata",
    paneId,
    "--source",
    "herdr-bot",
    "--agent",
    slug,
    "--display-agent",
    bot.name,
    "--title",
    bot.name,
  ]).catch(() => ({ stdout: "", stderr: "", exitCode: 0 }));
}

export async function openBot(idOrName: string): Promise<Bot> {
  const team = store.resumeDefaultTeam();
  const bot = store.findBot(team, idOrName);
  const agents = await agentList();
  const panes = await paneList();
  const live = findLive(bot, agents, panes);
  if (live) {
    bot.pane_id = live.pane_id;
    bot.agent_name = agentSlug(bot);
    store.saveTeam(team);
    await runner(["pane", "focus", live.pane_id]).catch(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    return bot;
  }
  const workspaceId = await ensureWorkspace(team);
  const paneId = await ensurePane(team, bot, workspaceId);
  await startHarness(bot, paneId);
  bot.pane_id = paneId;
  bot.agent_name = agentSlug(bot);
  store.saveTeam(team);
  return bot;
}

export async function ensureTeamLive(): Promise<LiveMember[]> {
  const team = store.resumeDefaultTeam();
  await ensureWorkspace(team);
  for (const bot of defaultBots(team)) {
    await openBot(bot.id);
  }
  return listLiveBots();
}

export async function listLiveBots(): Promise<LiveMember[]> {
  const team = store.resumeDefaultTeam();
  const agents = await agentList();
  const panes = await paneList();
  return defaultBots(team).map((bot) => {
    const live = findLive(bot, agents, panes);
    return {
      name: bot.name,
      slug: agentSlug(bot),
      body: bot.body,
      pane_id: live?.pane_id ?? bot.pane_id ?? null,
      status: live?.status ?? null,
      live: !!live,
    };
  });
}

export function liveGate(members: LiveMember[]): string[] {
  const names = members.filter((m) => m.live).map((m) => m.name);
  return names;
}

export function formatChannelPrompt(channel: string, fromName: string, text: string): string {
  return `[#${channel}] ${fromName}: ${text}`;
}

export async function deliverChannelPost(
  channel: string,
  fromIdOrName: string,
  text: string,
): Promise<{ delivered: LiveMember[]; skipped: Array<LiveMember & { reason?: string }> }> {
  const team = store.resumeDefaultTeam();
  const ch = store.findChannel(team, channel);
  const from = store.findBot(team, fromIdOrName);
  const agents = await agentList();
  const panes = await paneList();
  const prompt = formatChannelPrompt(ch.name, from.name, text);
  const delivered: LiveMember[] = [];
  const skipped: Array<LiveMember & { reason?: string }> = [];
  for (const id of ch.member_ids) {
    if (id === from.id) continue;
    const bot = team.members.find((b) => b.id === id);
    if (!bot) continue;
    const live = findLive(bot, agents, panes);
    const row: LiveMember = {
      name: bot.name,
      slug: agentSlug(bot),
      body: bot.body,
      pane_id: live?.pane_id ?? bot.pane_id ?? null,
      status: live?.status ?? null,
      live: !!live,
    };
    if (!live) {
      skipped.push({ ...row, reason: "not live" });
      continue;
    }
    try {
      await herdrJson(["agent", "prompt", agentSlug(bot), prompt]);
      delivered.push(row);
    } catch (err) {
      skipped.push({ ...row, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { delivered, skipped };
}

export { DEFAULT_SESSION, WORKSPACE_LABEL };
