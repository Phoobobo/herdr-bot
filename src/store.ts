// Team persistence. One team = one Herdr session.
// Default team uses session `default` and is seeded on first load.
// Mutation helpers accept both `(team, ...)` and shorthand forms so CLI/TUI/tests agree.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBody } from "./integrations.ts";
import {
  BotError,
  DEFAULT_BODY,
  DEFAULT_SEED_BOTS,
  DEFAULT_SESSION,
  DEFAULT_TEAM_ID,
  PLUGIN_ID,
  USER_DISPLAY_NAME,
  USER_ID,
  type Bot,
  type Channel,
  type ChannelMessage,
  type Team,
} from "./types.ts";

export const DEFAULT_MEMBERS: Array<Pick<Bot, "name" | "tag" | "description" | "body">> = DEFAULT_SEED_BOTS.map(
  (s) => ({ name: s.name, tag: s.tag, description: s.description, body: s.body }),
);

export function stateDir(): string {
  const explicit = process.env.HERDR_BOT_STATE_DIR || process.env.HERDR_PLUGIN_STATE_DIR;
  if (explicit && explicit.trim()) return explicit.trim();
  const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(xdgState, "herdr", "plugins", PLUGIN_ID);
}

function stateFile(): string {
  return path.join(stateDir(), "team.json");
}

function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function now(): number {
  return Date.now();
}

export function isTeam(x: unknown): x is Team {
  return !!x && typeof x === "object" && typeof (x as Team).session === "string" &&
    (Array.isArray((x as Team).members) || Array.isArray((x as Team).bots));
}

function syncAliases(team: Team): Team {
  const members = (team.members?.length ? team.members : team.bots) || [];
  team.members = members;
  team.bots = members;
  team.channels ||= [];
  team.dms ||= {};
  team.session ||= DEFAULT_SESSION;
  team.name ||= DEFAULT_TEAM_ID;
  team.id ||= DEFAULT_TEAM_ID;
  team.default = team.default !== false;
  team.version = 1;
  return team;
}

export function seedTeam(): Team {
  const t = now();
  const members: Bot[] = DEFAULT_SEED_BOTS.map((s) => ({
    id: s.id,
    name: s.name,
    tag: s.tag,
    description: s.description,
    body: s.body || DEFAULT_BODY,
    created_at: t,
    updated_at: t,
  }));
  return syncAliases({
    version: 1,
    id: DEFAULT_TEAM_ID,
    name: DEFAULT_TEAM_ID,
    session: DEFAULT_SESSION,
    default: true,
    members,
    bots: members,
    channels: [],
    dms: {},
    created_at: t,
    updated_at: t,
  });
}

export function saveTeam(team: Team): void {
  syncAliases(team);
  team.updated_at = now();
  writeAtomic(stateFile(), JSON.stringify(team, null, 2) + "\n");
}

export function saveState(team: Team): void {
  saveTeam(team);
}

export function loadState(): Team {
  const file = stateFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      const seeded = seedTeam();
      saveTeam(seeded);
      return seeded;
    }
    throw err;
  }
  try {
    return syncAliases(JSON.parse(raw) as Team);
  } catch {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // ignore
    }
    const seeded = seedTeam();
    saveTeam(seeded);
    return seeded;
  }
}

export function ensureDefaultTeam(): Team {
  return loadState();
}

export function loadOrSeedDefaultTeam(): Team {
  return loadState();
}

export function resumeDefaultTeam(): Team {
  return loadState();
}

export function memberNames(team?: Team): string[] {
  return syncAliases(team ?? loadState()).members.map((m) => m.name);
}

export function listBotNames(): string[] {
  return memberNames();
}

export function findBot(team: Team, idOrName: string): Bot {
  syncAliases(team);
  const bot = team.members.find((b) => b.id === idOrName || b.name === idOrName);
  if (!bot) throw new BotError("BOT_NOT_FOUND", `bot not found: ${idOrName}`);
  return bot;
}

export function findChannel(team: Team, idOrName: string): Channel {
  syncAliases(team);
  const ch = team.channels.find((c) => c.id === idOrName || c.name === idOrName);
  if (!ch) throw new BotError("CHANNEL_NOT_FOUND", `channel not found: ${idOrName}`);
  return ch;
}

export type BotInput = { name: string; tag?: string; description?: string; body?: string; id?: string };

export function createBot(input: BotInput): Bot;
export function createBot(team: Team, input: BotInput): Bot;
export function createBot(teamOrInput: Team | BotInput, input?: BotInput): Bot {
  const spec = (input ?? teamOrInput) as BotInput;
  const team = input ? syncAliases(teamOrInput as Team) : loadState();
  const name = spec.name.trim();
  if (!name) throw new BotError("BAD_REQUEST", "bot name is required");
  if (team.members.some((b) => b.name === name || (spec.id && b.id === spec.id))) {
    throw new BotError("BOT_EXISTS", `bot already exists: ${name}`);
  }
  const t = now();
  const bot: Bot = {
    id: spec.id || newId("bot"),
    name,
    tag: (spec.tag ?? "bot").trim() || "bot",
    description: spec.description ?? "",
    body: resolveBody(spec.body),
    created_at: t,
    updated_at: t,
  };
  team.members.push(bot);
  saveTeam(team);
  return bot;
}

export function renameBot(from: string, to: string): Bot;
export function renameBot(team: Team, from: string, to: string): Bot;
export function renameBot(teamOrFrom: Team | string, fromOrTo: string, to?: string): Bot {
  const team = typeof teamOrFrom === "string" ? loadState() : syncAliases(teamOrFrom);
  const from = typeof teamOrFrom === "string" ? teamOrFrom : fromOrTo;
  const name = (typeof teamOrFrom === "string" ? fromOrTo : to ?? "").trim();
  const bot = findBot(team, from);
  if (!name) throw new BotError("BAD_REQUEST", "new name is required");
  if (name !== bot.name && team.members.some((b) => b.name === name)) {
    throw new BotError("BOT_EXISTS", `bot already exists: ${name}`);
  }
  bot.name = name;
  bot.updated_at = now();
  saveTeam(team);
  return bot;
}

export function setTag(name: string, tag: string): Bot;
export function setTag(team: Team, name: string, tag: string): Bot;
export function setTag(teamOrName: Team | string, nameOrTag: string, tag?: string): Bot {
  const team = typeof teamOrName === "string" ? loadState() : syncAliases(teamOrName);
  const id = typeof teamOrName === "string" ? teamOrName : nameOrTag;
  const value = typeof teamOrName === "string" ? nameOrTag : tag ?? "";
  const bot = findBot(team, id);
  bot.tag = value;
  bot.updated_at = now();
  saveTeam(team);
  return bot;
}

export const setBotTag = setTag;

export function setDescription(name: string, description: string): Bot;
export function setDescription(team: Team, name: string, description: string): Bot;
export function setDescription(teamOrName: Team | string, nameOrDesc: string, description?: string): Bot {
  const team = typeof teamOrName === "string" ? loadState() : syncAliases(teamOrName);
  const id = typeof teamOrName === "string" ? teamOrName : nameOrDesc;
  const value = typeof teamOrName === "string" ? nameOrDesc : description ?? "";
  const bot = findBot(team, id);
  bot.description = value;
  bot.updated_at = now();
  saveTeam(team);
  return bot;
}

export const setBotDescription = setDescription;

export function setBody(name: string, body: string): Bot;
export function setBody(team: Team, name: string, body: string): Bot;
export function setBody(teamOrName: Team | string, nameOrBody: string, body?: string): Bot {
  const team = typeof teamOrName === "string" ? loadState() : syncAliases(teamOrName);
  const id = typeof teamOrName === "string" ? teamOrName : nameOrBody;
  const raw = (typeof teamOrName === "string" ? nameOrBody : body ?? "").trim();
  if (!raw) throw new BotError("BAD_REQUEST", "body is required");
  const value = resolveBody(raw);
  const bot = findBot(team, id);
  bot.body = value;
  bot.updated_at = now();
  saveTeam(team);
  return bot;
}

export const setBotBody = setBody;

export function createChannel(name: string): Channel;
export function createChannel(input: { name: string; description?: string }): Channel;
export function createChannel(team: Team, input: { name: string; description?: string } | string): Channel;
export function createChannel(
  teamOrName: Team | string | { name: string; description?: string },
  input?: { name: string; description?: string } | string,
): Channel {
  const team = isTeam(teamOrName) ? syncAliases(teamOrName) : loadState();
  const spec = isTeam(teamOrName)
    ? typeof input === "string"
      ? { name: input }
      : input!
    : typeof teamOrName === "string"
      ? { name: teamOrName }
      : teamOrName;
  const name = spec.name.trim();
  if (!name) throw new BotError("BAD_REQUEST", "channel name is required");
  if (team.channels.some((c) => c.name === name)) {
    throw new BotError("CHANNEL_EXISTS", `channel already exists: ${name}`);
  }
  const t = now();
  const ch: Channel = {
    id: newId("ch"),
    name,
    description: spec.description ?? "",
    member_ids: team.members.map((b) => b.id),
    messages: [],
    created_at: t,
    updated_at: t,
  };
  team.channels.push(ch);
  saveTeam(team);
  return ch;
}

export function isUserRef(idOrName: string): boolean {
  return idOrName === USER_ID || idOrName === USER_DISPLAY_NAME;
}

/** Resolve a message sender: the overlay user, or a bot id/name. */
export function resolveFrom(team: Team, fromIdOrName: string): { id: string; name: string } {
  if (isUserRef(fromIdOrName)) return { id: USER_ID, name: USER_DISPLAY_NAME };
  const bot = findBot(team, fromIdOrName);
  return { id: bot.id, name: bot.name };
}

export function postToChannel(channel: string, fromBot: string, text: string): ChannelMessage;
export function postToChannel(team: Team, channel: string, fromBot: string, text: string): ChannelMessage;
export function postToChannel(
  teamOrChannel: Team | string,
  channelOrFrom: string,
  fromOrText: string,
  text?: string,
): ChannelMessage {
  const team = typeof teamOrChannel === "string" ? loadState() : syncAliases(teamOrChannel);
  const channel = typeof teamOrChannel === "string" ? teamOrChannel : channelOrFrom;
  const fromBot = typeof teamOrChannel === "string" ? channelOrFrom : fromOrText;
  const msgText = typeof teamOrChannel === "string" ? fromOrText : text ?? "";
  const ch = findChannel(team, channel);
  const from = resolveFrom(team, fromBot);
  const msg: ChannelMessage = {
    id: newId("msg"),
    from_bot_id: from.id,
    text: msgText,
    created_at: now(),
  };
  ch.messages.push(msg);
  ch.updated_at = msg.created_at;
  saveTeam(team);
  return msg;
}

export function getDm(botId: string): ChannelMessage[];
export function getDm(team: Team, botId: string): ChannelMessage[];
export function getDm(teamOrBot: Team | string, botId?: string): ChannelMessage[] {
  const team = typeof teamOrBot === "string" ? loadState() : syncAliases(teamOrBot);
  const id = typeof teamOrBot === "string" ? teamOrBot : botId!;
  const bot = findBot(team, id);
  return team.dms?.[bot.id] ?? [];
}

export function postToDm(botId: string, fromIdOrName: string, text: string): ChannelMessage;
export function postToDm(team: Team, botId: string, fromIdOrName: string, text: string): ChannelMessage;
export function postToDm(
  teamOrBot: Team | string,
  botOrFrom: string,
  fromOrText?: string,
  text?: string,
): ChannelMessage {
  const team = typeof teamOrBot === "string" ? loadState() : syncAliases(teamOrBot);
  const botId = typeof teamOrBot === "string" ? teamOrBot : botOrFrom;
  const fromIdOrName = typeof teamOrBot === "string" ? botOrFrom : fromOrText!;
  const msgText = typeof teamOrBot === "string" ? fromOrText ?? "" : text ?? "";
  const bot = findBot(team, botId);
  const from = resolveFrom(team, fromIdOrName);
  const msg: ChannelMessage = {
    id: newId("msg"),
    from_bot_id: from.id,
    text: msgText,
    created_at: now(),
  };
  team.dms ||= {};
  team.dms[bot.id] ||= [];
  team.dms[bot.id].push(msg);
  saveTeam(team);
  return msg;
}
