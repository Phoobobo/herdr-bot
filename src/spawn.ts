// Open a bot = start its body as a live harness in the default Herdr session.
// Workspace tab1 is the bots TUI (`bots` / `herdr-bots`). From tab 2, one
// named tab per bot with panes: work, instant-msg, channel — each its own pi.

import * as store from "./store.ts";
import { PLUGIN_ID, runHerdr } from "./herdr.ts";
import {
  BotError,
  DEFAULT_MEMBER_NAMES,
  DEFAULT_SESSION,
  USER_DISPLAY_NAME,
  USER_ID,
  type Bot,
  type ChannelMessage,
  type Team,
} from "./types.ts";

export type RunResult = { stdout: string; stderr: string; exitCode: number };
export type HerdrRunner = (args: string[]) => Promise<RunResult>;

const WORKSPACE_LABEL = "herdr-bots";
const BOTS_TAB_LABEL = "bots";
const CWD = "/Users/phoobobo/Workspace/herdr-bot";
const PANE_WORK = "work";
const PANE_IM = "instant-msg";
const PANE_CH = "channel";
const PROMPT_TIMEOUT_MS = "120000";

export const IM_SESSION_HINT =
  "This pane is a private 1:1 instant-msg with the user. Other bots cannot see this conversation.";
export const CHANNEL_SESSION_HINT =
  "This pane is your voice in the shared #standup room. There is one shared message stream; every member sees the same thread.";

let runner: HerdrRunner = (args) => runHerdr(args);

export function setHerdrRunner(next: HerdrRunner | null): void {
  runner = next ?? ((args) => runHerdr(args));
}

export function agentSlug(bot: Pick<Bot, "id" | "name">): string {
  if (/^[a-z][a-z0-9_-]{0,31}$/.test(bot.id)) return bot.id;
  throw new BotError("BAD_REQUEST", `bot id is not a valid herdr agent name: ${bot.id}`);
}

export function imAgentSlug(bot: Pick<Bot, "id" | "name">): string {
  return sessionSlug(agentSlug(bot), "im");
}

export function chAgentSlug(bot: Pick<Bot, "id" | "name">): string {
  return sessionSlug(agentSlug(bot), "ch");
}

function sessionSlug(id: string, suffix: "im" | "ch"): string {
  const name = `${id}-${suffix}`;
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
    throw new BotError("BAD_REQUEST", `session agent name is invalid: ${name}`);
  }
  return name;
}

/** Identity injected into pi via `--system-prompt` on `herdr agent start`. */
export function identitySystemPrompt(bot: Pick<Bot, "name" | "tag" | "description">): string {
  return [
    `Your name is ${bot.name}. Description: ${bot.description}`,
    `Internal tag: ${bot.tag} (not your title; do not say this when asked who you are).`,
    "When asked who you are (你是谁), answer with this exact name and the description. Never replace the name with a generic title, and never introduce yourself as the tag.",
  ].join(" ");
}

export function sessionSystemPrompt(
  bot: Pick<Bot, "name" | "tag" | "description">,
  session: "work" | "im" | "channel",
): string {
  const identity = identitySystemPrompt(bot);
  if (session === "im") return `${identity} ${IM_SESSION_HINT}`;
  if (session === "channel") return `${identity} ${CHANNEL_SESSION_HINT}`;
  return identity;
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

/**
 * Pull the original reply text from `herdr agent prompt --wait` JSON.
 *
 * Real herdr 0.8.2 (documented): `.result.agent` is AgentInfo only — no message body.
 * Tests / future CLI: `.result.text` (also `.reply`, `.message`, `.read.text`).
 * Do not use extractReplyFor. If the wait JSON has no body, promptSessionAndWait
 * reads the same session slug and uses replyTextFromSessionRead.
 */
export function replyTextFromPromptResult(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === "string") {
    return result.trim() ? result : null;
  }
  if (typeof result !== "object") return null;
  const r = result as Record<string, any>;
  for (const key of ["text", "reply", "message", "content", "last_message", "last_reply"]) {
    const v = r[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  if (r.read && typeof r.read === "object" && typeof r.read.text === "string" && r.read.text.trim()) {
    return r.read.text;
  }
  if (r.agent && typeof r.agent === "object" && r.agent !== r) {
    return replyTextFromPromptResult(r.agent);
  }
  return null;
}

function isSessionSlug(slug: string): boolean {
  return /-(im|ch)$/.test(slug);
}

/**
 * After a successful `agent prompt --wait`, herdr 0.8.2 still has no message
 * body. Documented follow-up is `agent read` on that same session slug
 * (`*-im` / `*-ch` only). CLI prints `.result.read.text` (socket field) as
 * UTF-8; it is a raw terminal snapshot, not a last-assistant-message object.
 *
 * Slice: find the submitted prompt even when the pane hard-wraps it, then take
 * the visible assistant body after that inbound. Drop Pi grey thinking lines
 * and TUI chrome (any box-drawing line, including a Pi v0.x title bar, plus
 * cwd / token / model bars). Wrap-join unfinished fragments; keep finished
 * sentences on separate lines. This is not extractReplyFor.
 */
export function replyTextFromSessionRead(dump: string, prompt: string): string | null {
  if (!dump?.trim()) return null;
  const slice = sliceAfterPrompt(dump, prompt);
  const lines = slice.split(/\r?\n/);
  const paragraphs: string[][] = [];
  let current: string[] | null = null;
  let bodyStarted = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (isChromeLine(line)) {
      if (bodyStarted) break;
      continue;
    }
    if (!line) {
      if (current?.length) {
        paragraphs.push(current);
        current = null;
      }
      continue;
    }
    if (isThinkingLine(line)) continue;
    bodyStarted = true;
    if (!current) current = [];
    current.push(line);
  }
  if (current?.length) paragraphs.push(current);
  if (!paragraphs.length) return null;
  return paragraphs.map(joinWrapFragments).join("\n\n");
}

/** Pi grey status: whole-line English present-participle phrase, no punctuation. */
function isThinkingLine(line: string): boolean {
  return /^[A-Z][A-Za-z]*ing(?:\s+[A-Za-z]+)+$/.test(line);
}

const BOX_DRAWING = /[\u2500-\u257F]/;
const SENTENCE_END = /[。．.！!？?…]$/;

function isChromeLine(line: string): boolean {
  if (!line) return false;
  if (BOX_DRAWING.test(line)) return true;
  if (/\btokens\s*\|/.test(line)) return true;
  // cwd + branch, e.g. ~/Workspace/herdr-bot (main)
  if (/^[~\/][^\s].*\s\([^)]+\)\s*$/.test(line)) return true;
  // token / model bar: ↑1.2k ↓46 $0.000 … gpt-5.6-luna • high
  if (/[↑↓]/.test(line) && /\$/.test(line)) return true;
  if (/\bgpt-[\w.]+/.test(line) && /•/.test(line)) return true;
  return false;
}

function looksFinished(s: string): boolean {
  return SENTENCE_END.test(s);
}

function isAsciiAlnum(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9]/.test(ch);
}

function joinWrapFragments(parts: string[]): string {
  let out = "";
  for (const part of parts) {
    if (!out) {
      out = part;
      continue;
    }
    if (looksFinished(out)) {
      out += `\n${part}`;
      continue;
    }
    out += isAsciiAlnum(out[out.length - 1]) && isAsciiAlnum(part[0]) ? ` ${part}` : part;
  }
  return out;
}

/**
 * Locate the submitted prompt in a TUI dump. The pane may hard-wrap it, so a
 * contiguous lastIndexOf(prompt) can miss. Collapse dump lines with the same
 * wrap-join as the body and take text after that match. If the full prompt is
 * still missing, use a distinctive suffix (last prompt line, or [dm]/[#ch]
 * inbound). Never fall back to scanning from the top when that would pick the
 * Pi frame; only a chrome-free dump (e.g. a bare "pong") is used as-is.
 */
function sliceAfterPrompt(dump: string, prompt: string): string {
  if (!prompt) return dump;
  const idx = dump.lastIndexOf(prompt);
  if (idx >= 0) return dump.slice(idx + prompt.length);

  const wrapped = sliceAfterCollapsedPrompt(dump, prompt);
  if (wrapped != null) return wrapped;

  const suffix = sliceAfterDistinctiveSuffix(dump, prompt);
  if (suffix != null) return suffix;

  return dump;
}

function joinWrapMapped(pieces: { line: number; text: string }[]): { text: string; lineAt: number[] } {
  let text = "";
  const lineAt: number[] = [];
  for (const piece of pieces) {
    if (!piece.text) continue;
    if (text) {
      if (isAsciiAlnum(text[text.length - 1]) && isAsciiAlnum(piece.text[0])) {
        text += " ";
        lineAt.push(piece.line);
      }
    }
    text += piece.text;
    for (let i = 0; i < piece.text.length; i++) lineAt.push(piece.line);
  }
  return { text, lineAt };
}

function sliceAfterCollapsedPrompt(dump: string, prompt: string): string | null {
  const needle = joinWrapFragments(
    prompt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
  );
  if (!needle) return null;
  const lines = dump.split(/\r?\n/);
  const pieces: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (text) pieces.push({ line: i, text });
  }
  const collapsed = joinWrapMapped(pieces);
  const idx = collapsed.text.lastIndexOf(needle);
  if (idx < 0) return null;
  const lastLine = collapsed.lineAt[idx + needle.length - 1];
  if (lastLine == null) return "";
  return lines.slice(lastLine + 1).join("\n");
}

function sliceAfterDistinctiveSuffix(dump: string, prompt: string): string | null {
  const promptLines = prompt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lastPromptLine = promptLines[promptLines.length - 1];
  if (lastPromptLine && lastPromptLine !== prompt.trim()) {
    const idx = dump.lastIndexOf(lastPromptLine);
    if (idx >= 0) return dump.slice(idx + lastPromptLine.length);
  }

  const markerMatch = prompt.match(/\[(?:dm|#[^\]]+)\]\s+\S+:/);
  if (!markerMatch) return null;
  const markerIdx = dump.lastIndexOf(markerMatch[0]);
  if (markerIdx < 0) return null;

  const lines = dump.split(/\r?\n/);
  let pos = 0;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const end = pos + lines[i].length;
    if (markerIdx >= pos && markerIdx <= end) {
      startLine = i;
      break;
    }
    pos = end + 1;
  }
  if (startLine < 0) return null;

  const compactPrompt = prompt.replace(/\s+/g, "");
  let acc = "";
  let i = startLine;
  while (i < lines.length) {
    acc += lines[i].replace(/\s+/g, "");
    i++;
    if (acc.includes(compactPrompt)) break;
  }
  return lines.slice(i).join("\n");
}

function snapshotTextFromReadStdout(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = unwrap(stdout);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.read?.text === "string") return parsed.read.text;
      if (typeof parsed.text === "string" && parsed.text.trim()) return parsed.text;
      // JSON-RPC envelope with no snapshot field: CLI printed nothing.
      if (trimmed.startsWith("{") && parsed.read == null) return "";
    }
  } catch {
    // CLI `agent read` prints the snapshot as UTF-8, not JSON.
  }
  return stdout;
}

async function readSessionSnapshot(slug: string): Promise<string> {
  const res = await runner([
    "agent",
    "read",
    slug,
    "--source",
    "recent-unwrapped",
    "--lines",
    "160",
    "--format",
    "text",
  ]);
  if (res.exitCode !== 0) return "";
  return snapshotTextFromReadStdout(res.stdout);
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

function findAgent(agents: any[], slug: string): any | undefined {
  return agents.find((a) => agentName(a) === slug);
}

function findLive(bot: Bot, agents: any[], panes: any[]): { pane_id: string; status: string } | null {
  const slug = agentSlug(bot);
  const named = findAgent(agents, slug);
  if (named?.pane_id) {
    return { pane_id: named.pane_id, status: named.agent_status ?? "unknown" };
  }
  if (bot.pane_id) {
    const pane = panes.find((p) => p.pane_id === bot.pane_id);
    if (pane && pane.agent && pane.agent_status && pane.agent_status !== "unknown") {
      return { pane_id: pane.pane_id, status: pane.agent_status };
    }
  }
  return null;
}

function isBotsTabLabel(label: string | undefined | null): boolean {
  const v = String(label ?? "");
  return v === BOTS_TAB_LABEL || v === WORKSPACE_LABEL || v === "herdr-bots";
}

async function ensureWorkspace(team: Team): Promise<string> {
  const spaces = await workspaceList();
  const existing =
    (team.workspace_id && spaces.find((w) => w.workspace_id === team.workspace_id)) ||
    spaces.find((w) => w.label === WORKSPACE_LABEL || String(w.label ?? "").endsWith(WORKSPACE_LABEL));
  if (existing) {
    team.workspace_id = existing.workspace_id;
    store.saveTeam(team);
    await ensureBotsTab(existing.workspace_id);
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
  store.saveTeam(team);
  await ensureBotsTab(id);
  return id;
}

async function tabPanes(workspaceId: string): Promise<any[]> {
  const r = await herdrJson(["tab", "list", "--workspace", workspaceId]);
  return r.tabs ?? [];
}

async function ensureBotsTab(workspaceId: string): Promise<{ tabId: string; paneId: string }> {
  const tabs = await tabPanes(workspaceId);
  const memberNames = new Set<string>(DEFAULT_MEMBER_NAMES);
  const sorted = [...tabs].sort((a, b) => (a.number ?? 99) - (b.number ?? 99));
  let tab =
    sorted.find((t) => isBotsTabLabel(t.label)) ||
    sorted.find((t) => !memberNames.has(String(t.label ?? "")) && String(t.label ?? "") !== "1") ||
    sorted.find((t) => String(t.label ?? "") === "1") ||
    sorted[0];
  if (!tab?.tab_id) throw new BotError("HERDR", "herdr-bots workspace has no tab for the bots TUI");
  if (memberNames.has(String(tab.label ?? ""))) {
    throw new BotError("HERDR", "refusing to seat the bots TUI on a member tab");
  }
  if (!isBotsTabLabel(tab.label) || tab.label === "1") {
    await runner(["tab", "rename", tab.tab_id, BOTS_TAB_LABEL]).catch(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    tab.label = BOTS_TAB_LABEL;
  } else if (tab.label === WORKSPACE_LABEL || tab.label === "herdr-bots") {
    await runner(["tab", "rename", tab.tab_id, BOTS_TAB_LABEL]).catch(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    tab.label = BOTS_TAB_LABEL;
  }
  const panes = await paneList();
  const inTab =
    panes.find((p) => p.tab_id === tab.tab_id && p.workspace_id === workspaceId) ||
    panes.find((p) => p.tab_id === tab.tab_id);
  const paneId = inTab?.pane_id ?? tab.root_pane_id;
  if (!paneId) throw new BotError("HERDR", "bots tab has no pane");
  return { tabId: tab.tab_id, paneId };
}

async function ensureBotTab(bot: Bot, workspaceId: string): Promise<{ tabId: string; paneId: string }> {
  const tabs = await tabPanes(workspaceId);
  const tab = tabs.find((t) => t.label === bot.name && !isBotsTabLabel(t.label));
  if (tab) {
    const panes = await paneList();
    const inTab = panes.filter((p) => p.tab_id === tab.tab_id && p.workspace_id === workspaceId);
    const work = inTab.find((p) => p.label === PANE_WORK);
    const paneId = work?.pane_id ?? inTab[0]?.pane_id ?? tab.root_pane_id;
    if (!paneId) throw new BotError("HERDR", `bot tab ${bot.name} has no pane`);
    return { tabId: tab.tab_id, paneId };
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
  const tabId = created.tab?.tab_id ?? created.tab_id;
  if (tabId) {
    await runner(["tab", "rename", tabId, bot.name]).catch(() => ({ stdout: "", stderr: "", exitCode: 0 }));
  }
  return { tabId: tabId ?? "", paneId };
}

async function splitPane(paneId: string, direction: "right" | "down"): Promise<string> {
  const created = await herdrJson(["pane", "split", paneId, "--direction", direction, "--no-focus"]);
  const id = created.pane?.pane_id ?? created.pane_id;
  if (!id) throw new BotError("HERDR", `pane.split returned no pane from ${paneId}`);
  return id;
}

async function startAgent(
  bot: Bot,
  paneId: string,
  spec: { slug: string; paneLabel: string; session: "work" | "im" | "channel" },
): Promise<void> {
  const kind = bot.body || "pi";
  const startArgs = [
    "agent",
    "start",
    spec.slug,
    "--kind",
    kind,
    "--pane",
    paneId,
    "--timeout",
    "30000",
    "--",
    "--system-prompt",
    sessionSystemPrompt(bot, spec.session),
  ];
  // Fresh split panes can still be settling (not a shell yet). herdr then
  // returns agent_pane_busy. Retry the same start; do not kill other workspaces.
  const busy = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    return /agent_pane_busy/.test(msg);
  };
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await herdrJson(startArgs);
      break;
    } catch (err) {
      if (!busy(err) || attempt === 7) throw err;
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  await runner(["pane", "rename", paneId, spec.paneLabel]).catch(() => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
  }));
  await runner([
    "pane",
    "report-metadata",
    paneId,
    "--source",
    "herdr-bot",
    "--agent",
    spec.slug,
    "--display-agent",
    bot.name,
    "--title",
    spec.paneLabel,
  ]).catch(() => ({ stdout: "", stderr: "", exitCode: 0 }));
}

function tuiAlreadyRunning(info: any, paneId: string): boolean {
  const proc = info.process_info ?? info;
  const list = proc?.foreground_processes ?? info.foreground_processes ?? [];
  const blob = JSON.stringify(list);
  return blob.includes("tui.ts") || blob.includes("herdr-bot");
}

/** Run the bots TUI in workspace tab1 so focusing that tab shows it. Overlay is fallback. */
export async function openBotsTui(): Promise<void> {
  const team = store.resumeDefaultTeam();
  const workspaceId = await ensureWorkspace(team);
  const { paneId } = await ensureBotsTab(workspaceId);
  await runner(["pane", "rename", paneId, BOTS_TAB_LABEL]).catch(() => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
  }));
  let running = false;
  try {
    const info = await herdrJson(["pane", "process-info", paneId]);
    running = tuiAlreadyRunning(info, paneId);
  } catch {
    running = false;
  }
  if (!running) {
    const run = await runner(["pane", "run", paneId, "bun", "run", `${CWD}/src/tui.ts`]);
    if (run.exitCode !== 0) {
      const overlay = await runner([
        "plugin",
        "pane",
        "open",
        "--plugin",
        PLUGIN_ID,
        "--entrypoint",
        "tui",
        "--placement",
        "overlay",
        "--focus",
      ]);
      if (overlay.exitCode !== 0) {
        const err =
          (overlay.stderr || overlay.stdout).trim() || "failed to open herdr-bot TUI";
        throw new BotError("HERDR", err);
      }
      if (overlay.stdout.trim()) process.stdout.write(overlay.stdout);
      return;
    }
  }
  await runner(["pane", "focus", paneId]).catch(() => ({ stdout: "", stderr: "", exitCode: 0 }));
}

function ensureStandupChannel(team: Team): void {
  if (team.channels.some((c) => c.name === "standup")) return;
  store.createChannel(team, { name: "standup", description: "standup" });
}

async function ensureBotLive(bot: Bot, team: Team): Promise<void> {
  const workspaceId = await ensureWorkspace(team);
  const { tabId, paneId: rootPaneId } = await ensureBotTab(bot, workspaceId);
  const workSlug = agentSlug(bot);
  const imSlug = imAgentSlug(bot);
  const chSlug = chAgentSlug(bot);

  let agents = await agentList();
  let panes = await paneList();
  const inTab = () => panes.filter((p) => p.tab_id === tabId);

  const workNamed = findAgent(agents, workSlug);
  let workPane = workNamed?.pane_id ?? inTab().find((p) => p.label === PANE_WORK)?.pane_id ?? rootPaneId;
  if (!workNamed) {
    await startAgent(bot, workPane, { slug: workSlug, paneLabel: PANE_WORK, session: "work" });
  } else {
    await runner(["pane", "rename", workPane, PANE_WORK]).catch(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
  }

  agents = await agentList();
  panes = await paneList();
  const imNamed = findAgent(agents, imSlug);
  let imPane = imNamed?.pane_id ?? inTab().find((p) => p.label === PANE_IM)?.pane_id;
  if (!imPane) imPane = await splitPane(workPane, "right");
  if (!imNamed) {
    await startAgent(bot, imPane, { slug: imSlug, paneLabel: PANE_IM, session: "im" });
  } else {
    await runner(["pane", "rename", imPane, PANE_IM]).catch(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
  }

  agents = await agentList();
  panes = await paneList();
  const chNamed = findAgent(agents, chSlug);
  let chPane = chNamed?.pane_id ?? inTab().find((p) => p.label === PANE_CH)?.pane_id;
  if (!chPane) chPane = await splitPane(workPane, "down");
  if (!chNamed) {
    await startAgent(bot, chPane, { slug: chSlug, paneLabel: PANE_CH, session: "channel" });
  } else {
    await runner(["pane", "rename", chPane, PANE_CH]).catch(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
  }

  bot.pane_id = workPane;
  bot.agent_name = workSlug;
  bot.im_pane_id = imPane;
  bot.ch_pane_id = chPane;
  bot.im_agent = imSlug;
  bot.ch_agent = chSlug;
  store.saveTeam(team);
}

export async function openBot(idOrName: string): Promise<Bot> {
  const team = store.resumeDefaultTeam();
  const bot = store.findBot(team, idOrName);
  ensureStandupChannel(team);
  await ensureBotLive(bot, team);
  if (bot.pane_id) {
    await runner(["pane", "focus", bot.pane_id]).catch(() => ({ stdout: "", stderr: "", exitCode: 0 }));
  }
  return bot;
}

export async function ensureTeamLive(): Promise<LiveMember[]> {
  const team = store.resumeDefaultTeam();
  await ensureWorkspace(team);
  ensureStandupChannel(team);
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

export function formatDmPrompt(text: string): string {
  return `[dm] ${USER_DISPLAY_NAME}: ${text}`;
}

function senderDisplay(team: Team, fromId: string): string {
  if (fromId === USER_ID) return USER_DISPLAY_NAME;
  return team.members.find((b) => b.id === fromId)?.name ?? fromId;
}

/** One shared #channel stream: every member's channel pane sees the same who-said-what thread. */
export function formatSharedChannelPrompt(
  channel: string,
  fromName: string,
  text: string,
  thread: string[],
): string {
  const inbound = formatChannelPrompt(channel, fromName, text);
  return [
    `You are in the shared #${channel} room. There is one message stream; every member sees the same thread.`,
    thread.length ? "Recent thread:" : "The shared thread so far is empty except this post.",
    ...thread.map((line) => `  ${line}`),
    `New message: ${inbound}`,
    "Reply as yourself. Your reply is appended to this same shared thread.",
  ].join("\n");
}

async function promptSessionAndWait(slug: string, text: string): Promise<string | null> {
  // Omit --until so herdr's default matches idle, done, or blocked.
  // A single --until idle misses live pi sessions that settle at done.
  const result = await herdrJson([
    "agent",
    "prompt",
    slug,
    text,
    "--wait",
    "--timeout",
    PROMPT_TIMEOUT_MS,
  ]);
  const fromWait = replyTextFromPromptResult(result);
  if (fromWait) return fromWait;
  if (!isSessionSlug(slug)) return null;
  const dump = await readSessionSnapshot(slug);
  return replyTextFromSessionRead(dump, text);
}

export async function deliverChannelPost(
  channel: string,
  fromIdOrName: string,
  text: string,
): Promise<{ delivered: LiveMember[]; skipped: Array<LiveMember & { reason?: string }> }> {
  const team = store.resumeDefaultTeam();
  const ch = store.findChannel(team, channel);
  const from = store.resolveFrom(team, fromIdOrName);
  const agents = await agentList();
  const panes = await paneList();
  const delivered: LiveMember[] = [];
  const skipped: Array<LiveMember & { reason?: string }> = [];
  for (const id of ch.member_ids) {
    if (from.id !== USER_ID && id === from.id) continue;
    const bot = team.members.find((b) => b.id === id);
    if (!bot) continue;
    const slug = chAgentSlug(bot);
    const named = findAgent(agents, slug);
    const work = findLive(bot, agents, panes);
    const row: LiveMember = {
      name: bot.name,
      slug,
      body: bot.body,
      pane_id: named?.pane_id ?? bot.ch_pane_id ?? work?.pane_id ?? bot.pane_id ?? null,
      status: named?.agent_status ?? work?.status ?? null,
      live: !!named,
    };
    if (!named) {
      skipped.push({ ...row, reason: "not live" });
      continue;
    }
    try {
      const liveTeam = store.resumeDefaultTeam();
      const liveCh = store.findChannel(liveTeam, channel);
      const thread = liveCh.messages.map(
        (m) => `${senderDisplay(liveTeam, m.from_bot_id)}: ${m.text}`,
      );
      const prompt = formatSharedChannelPrompt(liveCh.name, from.name, text, thread);
      const reply = await promptSessionAndWait(slug, prompt);
      if (reply) store.postToChannel(ch.id, bot.id, reply);
      delivered.push(row);
    } catch (err) {
      skipped.push({ ...row, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { delivered, skipped };
}

export async function deliverDmPost(botIdOrName: string, text: string): Promise<Bot> {
  const bot = await openBot(botIdOrName);
  const reply = await promptSessionAndWait(imAgentSlug(bot), formatDmPrompt(text));
  if (reply) store.postToDm(bot.id, bot.id, reply);
  return bot;
}

export async function sendComposer(
  sel: { kind: "bot" | "channel"; index: number },
  text: string,
): Promise<ChannelMessage | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const team = store.resumeDefaultTeam();
  if (sel.kind === "bot") {
    const bot = team.members[sel.index];
    if (!bot) throw new BotError("BOT_NOT_FOUND", "no bot selected");
    const msg = store.postToDm(bot.id, USER_ID, trimmed);
    await deliverDmPost(bot.id, trimmed);
    return msg;
  }
  const ch = team.channels[sel.index];
  if (!ch) throw new BotError("CHANNEL_NOT_FOUND", "no channel selected");
  const msg = store.postToChannel(ch.id, USER_ID, trimmed);
  await deliverChannelPost(ch.id, USER_ID, trimmed);
  return msg;
}

export {
  DEFAULT_SESSION,
  WORKSPACE_LABEL,
  BOTS_TAB_LABEL,
  PANE_WORK,
  PANE_IM,
  PANE_CH,
  PROMPT_TIMEOUT_MS,
};
