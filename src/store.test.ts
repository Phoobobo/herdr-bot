import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MEMBER_NAMES, DEFAULT_SEED_BOTS } from "./types.ts";
import {
  createBot,
  createChannel,
  loadOrSeedDefaultTeam,
  memberNames,
  postToChannel,
  renameBot,
  resumeDefaultTeam,
  setBotBody,
  setBotDescription,
  setBotTag,
} from "./store.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-bot-store-"));
  process.env.HERDR_BOT_STATE_DIR = dir;
  process.env.HERDR_BOT_BODIES = "pi,omp,claude,codex,copilot,opencode,hermes,grok";
});

afterEach(() => {
  delete process.env.HERDR_BOT_STATE_DIR;
  delete process.env.HERDR_BOT_BODIES;
  fs.rmSync(dir, { recursive: true, force: true });
});

function roster(team: { members?: { name: string }[]; bots?: { name: string }[] }): string[] {
  const list = (team.members?.length ? team.members : team.bots) ?? [];
  return list.map((b) => b.name);
}

test("QA gate: default team members are exactly 幕僚长, 研发工程师, 研究员, 测试工程师", () => {
  const team = resumeDefaultTeam();
  const names = memberNames(team);
  expect(names).toEqual([...DEFAULT_MEMBER_NAMES]);
  expect(names).toHaveLength(4);
  expect(new Set(names).size).toBe(4);
  expect(roster(team)).toEqual([...DEFAULT_MEMBER_NAMES]);
});

test("seed is idempotent: second resume does not add extra members", () => {
  const first = loadOrSeedDefaultTeam();
  const second = loadOrSeedDefaultTeam();
  expect(memberNames(second)).toEqual(memberNames(first));
  expect(memberNames(second)).toEqual([...DEFAULT_MEMBER_NAMES]);
  expect(roster(second)).toHaveLength(4);
});

test("default bots have seeded tag, description, and body pi", () => {
  const team = resumeDefaultTeam();
  const list = (team.members?.length ? team.members : team.bots) ?? [];
  for (const seed of DEFAULT_SEED_BOTS) {
    const bot = list.find((b) => b.name === seed.name);
    expect(bot).toBeDefined();
    expect(bot!.tag).toBe(seed.tag);
    expect(bot!.description).toBe(seed.description);
    expect(bot!.body).toBe("pi");
  }
  expect(team.session).toBe("default");
  expect(team.default).toBe(true);
});

test("create / rename / tag / description / body / channel round-trip", () => {
  resumeDefaultTeam();
  const bot = createBot({
    name: "观察员",
    tag: "watch",
    description: "watches the board",
    body: "omp",
  });
  expect(bot.body).toBe("omp");
  renameBot(bot.id, "值班观察员");
  setBotTag(bot.id, "duty");
  setBotDescription(bot.id, "on duty");
  setBotBody(bot.id, "grok");
  const ch = createChannel({ name: "standup" });
  postToChannel(ch.id, "lead", "hello team");
  const reloaded = loadOrSeedDefaultTeam();
  const list = (reloaded.members?.length ? reloaded.members : reloaded.bots) ?? [];
  const found = list.find((b) => b.id === bot.id)!;
  expect(found.name).toBe("值班观察员");
  expect(found.tag).toBe("duty");
  expect(found.description).toBe("on duty");
  expect(found.body).toBe("grok");
  expect(reloaded.channels[0].name).toBe("standup");
  expect(reloaded.channels[0].messages[0].text).toBe("hello team");
  expect(memberNames(reloaded).slice(0, 4)).toEqual([...DEFAULT_MEMBER_NAMES]);
});

test("set body to omp must persist as omp, not fall back to pi", () => {
  const team = resumeDefaultTeam();
  const eng = team.members.find((b) => b.name === "研发工程师")!;
  expect(eng.body).toBe("pi");
  const updated = setBotBody(eng.id, "omp");
  expect(updated.body).toBe("omp");
  const reloaded = loadOrSeedDefaultTeam();
  const found = reloaded.members.find((b) => b.id === eng.id)!;
  expect(found.body).toBe("omp");
  expect(found.body).not.toBe("pi");
});
