// Pure chat view-model for the overlay. No TTY required.

import { getDm } from "./store.ts";
import { senderDisplayName, threadLines } from "./thread.ts";
import type { Team } from "./types.ts";

export type ChatSel = { kind: "bot" | "channel"; index: number };

export interface ChatView {
  sidebarBots: string[];
  sidebarChannels: string[];
  header: string;
  kind: "dm" | "channel";
  showingProfile: boolean;
  thread: string[];
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
  };
}
