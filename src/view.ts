// Pure chat view-model for the overlay. No TTY required.

import { getDm } from "./store.ts";
import { senderDisplayName, threadLines } from "./thread.ts";
import type { ChannelMessage, Team } from "./types.ts";
import { strWidth, truncate, wrapText } from "./ui.ts";

export type ChatSel = { kind: "bot" | "channel"; index: number };

/** One stored message, ready to render. */
export interface ThreadEntry {
  id: string;
  sender: string;
  /** Full stored text; newlines preserved. */
  text: string;
  /** Id this message answers (absent on old records and user posts). */
  reply_to?: string | null;
  /**
   * Set when the reply's question is not the message directly above it
   * (e.g. two quick sends stored Q,Q,A,A): a short quote of the question, so
   * the order mismatch is visible. `null` quote = the target id is unknown.
   */
  replyLabel?: string | null;
}

export interface ChatView {
  sidebarBots: string[];
  sidebarChannels: string[];
  header: string;
  kind: "dm" | "channel";
  showingProfile: boolean;
  /** Flat `sender: text` strings (text verbatim, may contain newlines). */
  thread: string[];
  entries: ThreadEntry[];
}

const LABEL_QUOTE_W = 40;

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}

export function threadEntries(team: Team, msgs: ChannelMessage[]): ThreadEntry[] {
  const byId = new Map(msgs.map((m) => [m.id, m]));
  return msgs.map((m, i) => {
    const entry: ThreadEntry = { id: m.id, sender: senderDisplayName(team, m.from_bot_id), text: m.text };
    if (!m.reply_to) return entry;
    entry.reply_to = m.reply_to;
    // In channels several bots answer one post: siblings answering the same
    // question directly before us still count as "under" it.
    let j = i - 1;
    while (j >= 0 && msgs[j].reply_to === m.reply_to) j--;
    if (j >= 0 && msgs[j].id === m.reply_to) return entry;
    const q = byId.get(m.reply_to);
    entry.replyLabel = q
      ? `↳ re ${senderDisplayName(team, q.from_bot_id)}: ${truncate(firstLine(q.text), LABEL_QUOTE_W)}`
      : null;
    return entry;
  });
}

export interface ThreadRow {
  text: string;
  /** `↳ re …` reply label (rendered dim). */
  label?: boolean;
}

/**
 * Lay a thread out as display rows of at most `width` columns. Every stored
 * line is kept (wrapped CJK-width aware, never truncated); continuation rows
 * hang under the text after `sender: `. Replies whose question is not directly
 * above them get a `↳ re …` label row first. Callers scroll over the result.
 */
export function threadLayout(entries: ThreadEntry[], width: number): ThreadRow[] {
  const w = Math.max(1, width);
  const rows: ThreadRow[] = [];
  for (const e of entries) {
    if (e.reply_to && e.replyLabel !== undefined) {
      rows.push({ text: truncate(e.replyLabel ?? "↳ re: (earlier message not found)", w), label: true });
    }
    const prefix = `${e.sender}: `;
    const pw = strWidth(prefix);
    // Hang under the prefix when it leaves room; otherwise a small indent.
    const hang = pw <= Math.floor(w / 2) ? pw : Math.min(2, w - 1);
    const body = wrapText(e.text, w - hang);
    if (hang === pw) {
      rows.push({ text: prefix + body[0] });
    } else {
      rows.push({ text: truncate(prefix.trimEnd(), w) });
      rows.push({ text: " ".repeat(hang) + body[0] });
    }
    for (const r of body.slice(1)) rows.push({ text: " ".repeat(hang) + r });
  }
  return rows;
}

export function threadRows(entries: ThreadEntry[], width: number): string[] {
  return threadLayout(entries, width).map((r) => r.text);
}

/** Clamp a scroll offset (rows hidden below the viewport) for `total` rows in `height`. */
export function clampScroll(offset: number, total: number, height: number): number {
  return Math.max(0, Math.min(offset, Math.max(0, total - height)));
}

/** The rows visible in a viewport of `height`, `offset` rows up from the bottom. */
export function visibleRows<T>(rows: T[], height: number, offset: number): T[] {
  const h = Math.max(1, height);
  const off = clampScroll(offset, rows.length, h);
  const end = rows.length - off;
  return rows.slice(Math.max(0, end - h), end);
}
export function chatView(team: Team, sel: ChatSel): ChatView {
  const sidebarBots = team.members.map((b) => b.name);
  const sidebarChannels = team.channels.map((c) => `#${c.name}`);
  if (sel.kind === "bot") {
    const bot = team.members[sel.index];
    const msgs = bot ? getDm(team, bot.id) : [];
    return {
      sidebarBots,
      sidebarChannels,
      header: bot?.name ?? "",
      kind: "dm",
      showingProfile: false,
      thread: msgs.map((m) => `${senderDisplayName(team, m.from_bot_id)}: ${m.text}`),
      entries: threadEntries(team, msgs),
    };
  }
  const ch = team.channels[sel.index];
  return {
    sidebarBots,
    sidebarChannels,
    header: ch ? `#${ch.name}` : "",
    kind: "channel",
    showingProfile: false,
    thread: ch ? threadLines(team, ch) : [],
    entries: ch ? threadEntries(team, ch.messages) : [],
  };
}
