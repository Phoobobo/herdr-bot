// Pull live pane replies back into a channel thread.
// Overlay log is the source of outbound posts; pane reads fill in the replies.

import * as store from "./store.ts";
import { runHerdr } from "./herdr.ts";
import { agentSlug } from "./spawn.ts";
import type { Bot, Channel, ChannelMessage, Team } from "./types.ts";

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
  return `[#${channel}] ${fromName}: ${text}`.trim();
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
    const inbound = line.match(/^\[#([^\]]+)\]\s+([^:]+):\s*(.*)$/);
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
    const bot = team.members.find((b) => b.id === msg.from_bot_id);
    return !!bot;
  });

  for (const bot of team.members) {
    if (!bot.pane_id && !/^[a-z]/.test(bot.id)) continue;
    let paneText = "";
    try {
      paneText = await reader(agentSlug(bot));
    } catch {
      continue;
    }
    if (!paneText.trim()) continue;

    for (const outbound of outbounds) {
      const author = team.members.find((b) => b.id === outbound.from_bot_id);
      if (!author || author.id === bot.id) continue;
      const reply = extractReplyFor(paneText, ch.name, author.name, outbound.text);
      if (!reply) continue;
      if (alreadyHas(ch, bot.id, reply)) continue;
      const message = store.postToChannel(ch.id, bot.id, reply);
      added.push({ from: bot.name, text: reply, message });
    }
  }

  return { channel: store.findChannel(store.resumeDefaultTeam(), channel), added };
}

export function threadLines(team: Team, ch: Channel): string[] {
  return ch.messages.map((m) => {
    const name = team.members.find((b) => b.id === m.from_bot_id)?.name ?? m.from_bot_id;
    return `${name}: ${m.text}`;
  });
}
