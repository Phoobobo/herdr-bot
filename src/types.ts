// herdr-bot data model. One team owns one Herdr session.

export const PLUGIN_ID = "phoobobo.herdr-bot";
export const DEFAULT_TEAM_ID = "default";
export const DEFAULT_SESSION = "default";
/** Default harness. `pi` stays available as an optional body (`body: pi`). */
export const DEFAULT_BODY = "grok";
/** Default Grok Build model; per-bot override in Bot.model. */
export const DEFAULT_MODEL = "grok-4.7";

export type SessionKind = "work" | "im" | "ch";

export const DEFAULT_MEMBER_NAMES = ["幕僚长", "研发工程师", "研究员", "测试工程师"] as const;

/** Overlay user (not a bot). DM/channel posts from the composer use this id. */
export const USER_ID = "user";
export const USER_DISPLAY_NAME = "Phoobobo";

export interface Bot {
  id: string;
  name: string;
  tag: string;
  description: string;
  body: string;
  pane_id?: string | null;
  agent_name?: string | null;
  /** instant-msg session pane (1:1 with the user). Optional for seed/backward compat. */
  im_pane_id?: string | null;
  /** channel session pane (#standup). Optional for seed/backward compat. */
  ch_pane_id?: string | null;
  im_agent?: string | null;
  ch_agent?: string | null;
  /** Grok model id for body=grok (null/absent = DEFAULT_MODEL). */
  model?: string | null;
  /**
   * Pinned grok session UUIDs per pane. Started with `grok --session-id`,
   * restarted with `grok --resume`; write-back reads
   * ~/.grok/sessions/<cwd>/<id>/updates.jsonl.
   */
  grok_sessions?: Partial<Record<SessionKind, string>> | null;
  created_at: number;
  updated_at: number;
}

export interface ChannelMessage {
  id: string;
  from_bot_id: string;
  text: string;
  created_at: number;
  /**
   * Id of the message this one answers (bot replies only). Optional: records
   * written before reply_to existed have no link and render as plain messages.
   */
  reply_to?: string | null;
}

export interface PostOptions {
  /** Id of the message being answered. */
  reply_to?: string | null;
}

export interface Channel {
  id: string;
  name: string;
  description: string;
  member_ids: string[];
  messages: ChannelMessage[];
  created_at: number;
  updated_at: number;
}

export interface Team {
  version: 1;
  id: string;
  name: string;
  session: string;
  default: boolean;
  members: Bot[];
  bots: Bot[];
  channels: Channel[];
  /** 1:1 threads keyed by bot id. Optional for backward compatibility; version stays 1. */
  dms?: Record<string, ChannelMessage[]>;
  workspace_id?: string | null;
  created_at: number;
  updated_at: number;
}

export interface SeedBot {
  id: string;
  name: string;
  tag: string;
  description: string;
  body: string;
}

/** Canonical default roster. Extra or missing names is a product failure. */
export const DEFAULT_SEED_BOTS: readonly SeedBot[] = [
  {
    id: "lead",
    name: "幕僚长",
    tag: "lead",
    description: "管理你的其他 Bot，需要决策时找你",
    body: DEFAULT_BODY,
  },
  {
    id: "eng",
    name: "研发工程师",
    tag: "eng",
    description: "You are an awesome software engineer.",
    body: DEFAULT_BODY,
  },
  {
    id: "research",
    name: "研究员",
    tag: "research",
    description: "The user works with GitHub every day — start with those tools when suggesting connectors or taking on work.",
    body: DEFAULT_BODY,
  },
  {
    id: "qa",
    name: "测试工程师",
    tag: "qa",
    description: "You are an awesome Quality Assurance Engineer.",
    body: DEFAULT_BODY,
  },
];

export class BotError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BotError";
    this.code = code;
  }
}
