// Pull live pane replies back into a channel thread (CLI `channel sync` only).
// The TUI path must not use this: sendComposer waits on `agent prompt --wait`
// and writes `.result.text` (or reply/message/read.text) into the store.

import * as store from "./store.ts";
import { runHerdr } from "./herdr.ts";
import { agentSlug } from "./spawn.ts";
import { USER_DISPLAY_NAME, USER_ID, type Channel, type ChannelMessage, type Team } from "./types.ts";

export type PaneReader = (slug: string) => Promise<string>;

let reader: PaneReader = async (slug) => {
  const res = await runHerdr([
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
  return res.stdout;
};

export function setPaneReader(next: PaneReader | null): void {
  reader = next ?? (async (slug) => {
    const res = await runHerdr([
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
    return res.stdout;
  });
}

const THINK =
  /^(preparing|planning|loading|checking|formulating|deciding|took\s|package |update available|new version|changelog:|\[skills?\]|\[extensions\]|\[skill\]|\$ |working|thinking)/i;
const BOX = /^[\s╭╮╰╯─│━│]+$/;
const FOOTER = /(CH\d|\$\d|gpt-|openai-codex|pi update|auto\)|↑)/i;

export function inboundMarker(channel: string, fromName: string, text: string): string {
  const tag = channel === "dm" ? "dm" : `#${channel}`;
  return `[${tag}] ${fromName}: ${text}`.trim();
}

function isChrome(line: string): boolean {
  if (!line) return true;
  if (BOX.test(line)) return true;
  if (THINK.test(line)) return true;
  if (FOOTER.test(line)) return true;
  if (/^~\//.test(line)) return true;
  if (/^[A-Z][A-Z0-9_]*=/.test(line) && !/\s/.test(line)) return true;
  if (/^Packages?:/.test(line)) return true;
  return false;
}

export function extractReplyFor(
  paneText: string,
  channel: string,
  inboundFrom: string,
  inboundText: string,
): string | null {
  const marker = inboundMarker(channel, inboundFrom, inboundText);
  const src = paneText.replace(/\r/g, "");
  const idx = src.lastIndexOf(marker);
  if (idx < 0) return null;
  const collected: string[] = [];
  for (const raw of src.slice(idx + marker.length).split(/\n/)) {
    const line = raw.trim();
    if (!line) {
      if (collected.length) break;
      continue;
    }
    if (isChrome(line)) continue;
    const inbound = line.match(/^\[#?([^\]]+)\]\s+([^:]+):\s*(.*)$/);
    if (inbound && collected.length) break;
    const piece = (inbound ? inbound[3] : line).trim();
    if (!piece) continue;
    collected.push(piece);
    if (inbound) break;
  }
  return collected.join("\n") || null;
}

export interface SyncedReply {
  from: string;
  text: string;
  message: ChannelMessage;
}

function alreadyHas(ch: Channel, fromId: string, text: string): boolean {
  return ch.messages.some((m) => m.from_bot_id === fromId && m.text === text);
}

export async function syncChannelReplies(channel: string): Promise<{ channel: Channel; added: SyncedReply[] }> {
  const team = store.resumeDefaultTeam();
  const ch = store.findChannel(team, channel);
  const added: SyncedReply[] = [];
  const outbounds = ch.messages.filter((msg) => {
    if (msg.from_bot_id === USER_ID) return true;
    return !!team.members.find((b) => b.id === msg.from_bot_id);
  });

  for (const bot of team.members) {
    if (!bot.pane_id && !/^[a-z]/.test(bot.id)) continue;
    // grok bodies write back from grok's session log (spawn.ts); never scrape their screens.
    if ((bot.body || "grok") === "grok") continue;
    let paneText = "";
    try {
      paneText = await reader(agentSlug(bot));
    } catch {
      continue;
    }
    if (!paneText.trim()) continue;

    for (const outbound of outbounds) {
      if (outbound.from_bot_id === bot.id) continue;
      const authorName = senderDisplayName(team, outbound.from_bot_id);
      const reply = extractReplyFor(paneText, ch.name, authorName, outbound.text);
      if (!reply) continue;
      if (alreadyHas(ch, bot.id, reply)) continue;
      const message = store.postToChannel(ch.id, bot.id, reply, { reply_to: outbound.id });
      added.push({ from: bot.name, text: reply, message });
    }
  }

  return { channel: store.findChannel(store.resumeDefaultTeam(), channel), added };
}

export function senderDisplayName(team: Team, fromId: string): string {
  if (fromId === USER_ID) return USER_DISPLAY_NAME;
  return team.members.find((b) => b.id === fromId)?.name ?? fromId;
}

export function threadLines(team: Team, ch: Channel): string[] {
  return ch.messages.map((m) => `${senderDisplayName(team, m.from_bot_id)}: ${m.text}`);
}

export async function syncDmReplies(botIdOrName: string): Promise<{ added: SyncedReply[] }> {
  const team = store.resumeDefaultTeam();
  const bot = store.findBot(team, botIdOrName);
  const added: SyncedReply[] = [];
  // grok bodies write back from grok's session log (spawn.ts); never scrape their screens.
  if ((bot.body || "grok") === "grok") return { added };
  let paneText = "";
  try {
    paneText = await reader(agentSlug(bot));
  } catch {
    return { added };
  }
  if (!paneText.trim()) return { added };

  const outbounds = store.getDm(bot.id).filter((m) => m.from_bot_id === USER_ID);
  for (const outbound of outbounds) {
    const reply = extractReplyFor(paneText, "dm", USER_DISPLAY_NAME, outbound.text);
    if (!reply) continue;
    const current = store.getDm(bot.id);
    if (current.some((m) => m.from_bot_id === bot.id && m.text === reply)) continue;
    const message = store.postToDm(bot.id, bot.id, reply, { reply_to: outbound.id });
    added.push({ from: bot.name, text: reply, message });
  }
  return { added };
}
