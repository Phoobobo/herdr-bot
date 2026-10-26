import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MEMBER_NAMES, DEFAULT_SEED_BOTS } from "./types.ts";
import { USER_DISPLAY_NAME, USER_ID } from "./types.ts";
import {
  botModel,
  createBot,
  createChannel,
  getDm,
  loadOrSeedDefaultTeam,
  memberNames,
  postToChannel,
  postToDm,
  renameBot,
  resumeDefaultTeam,
  setBotBody,
  setBotDescription,
  setBotTag,
  setModel,
  saveTeam,
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

test("default bots have seeded tag, description, and body grok", () => {
  const team = resumeDefaultTeam();
  const list = (team.members?.length ? team.members : team.bots) ?? [];
  for (const seed of DEFAULT_SEED_BOTS) {
    const bot = list.find((b) => b.name === seed.name);
    expect(bot).toBeDefined();
    expect(bot!.tag).toBe(seed.tag);
    expect(bot!.description).toBe(seed.description);
    expect(bot!.body).toBe("grok");
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

test("set body to omp must persist as omp, not fall back to the default", () => {
  const team = resumeDefaultTeam();
  const eng = team.members.find((b) => b.name === "研发工程师")!;
  expect(eng.body).toBe("grok");
  const updated = setBotBody(eng.id, "omp");
  expect(updated.body).toBe("omp");
  const reloaded = loadOrSeedDefaultTeam();
  const found = reloaded.members.find((b) => b.id === eng.id)!;
  expect(found.body).toBe("omp");
  expect(found.body).not.toBe("grok");
});

test("pi stays an optional body; grok model is per bot with default grok-4.7", () => {
  resumeDefaultTeam();
  expect(setBotBody("qa", "pi").body).toBe("pi");
  expect(loadOrSeedDefaultTeam().members.find((b) => b.id === "qa")!.body).toBe("pi");
  const lead = loadOrSeedDefaultTeam().members.find((b) => b.id === "lead")!;
  expect(botModel(lead)).toBe("grok-4.7");
  expect(setModel("lead", " grok-4.6 ").model).toBe("grok-4.6");
  expect(botModel(loadOrSeedDefaultTeam().members.find((b) => b.id === "lead")!)).toBe("grok-4.6");
  expect(() => setModel("lead", "")).toThrow(/model is required/);
  expect(() => setModel("lead", "grok 4")).toThrow(/invalid model id/);
  expect(createBot({ name: "模型测试", model: "grok-4.5" }).model).toBe("grok-4.5");
});

test("postToDm user→bot persists across reload", () => {
  resumeDefaultTeam();
  const msg = postToDm("lead", "user", "hello 幕僚长");
  expect(msg.from_bot_id).toBe(USER_ID);
  expect(msg.text).toBe("hello 幕僚长");
  const first = getDm("lead");
  expect(first).toHaveLength(1);
  expect(first[0].from_bot_id).toBe("user");
  const reloaded = loadOrSeedDefaultTeam();
  const kept = getDm(reloaded, "lead");
  expect(kept).toHaveLength(1);
  expect(kept[0].text).toBe("hello 幕僚长");
  expect(kept[0].from_bot_id).toBe(USER_ID);
});

test("postToChannel from user works", () => {
  resumeDefaultTeam();
  createChannel({ name: "standup" });
  const msg = postToChannel("standup", USER_DISPLAY_NAME, "hi from me");
  expect(msg.from_bot_id).toBe(USER_ID);
  const reloaded = loadOrSeedDefaultTeam();
  expect(reloaded.channels[0].messages[0].from_bot_id).toBe("user");
  expect(reloaded.channels[0].messages[0].text).toBe("hi from me");
});

test("postToChannel from lead still works", () => {
  resumeDefaultTeam();
  createChannel({ name: "standup" });
  const msg = postToChannel("standup", "lead", "hello team");
  expect(msg.from_bot_id).toBe("lead");
  const reloaded = loadOrSeedDefaultTeam();
  expect(reloaded.channels[0].messages[0].from_bot_id).toBe("lead");
  expect(reloaded.channels[0].messages[0].text).toBe("hello team");
});

test("saving a stale team snapshot keeps DMs and grok sessions written meanwhile", () => {
  const stale = resumeDefaultTeam();
  const fresh = resumeDefaultTeam();
  fresh.members[1].grok_sessions = { im: "01a173e3-470b-73ab-80e8-e39f64ace877" };
  saveTeam(fresh);
  postToDm("eng", USER_ID, "first");
  postToDm("eng", "eng", "reply one");
  stale.workspace_id = "w9";
  saveTeam(stale);
  const after = resumeDefaultTeam();
  expect(after.workspace_id).toBe("w9");
  expect(getDm("eng").map((m) => m.text)).toEqual(["first", "reply one"]);
  expect(after.members[1].grok_sessions?.im).toBe("01a173e3-470b-73ab-80e8-e39f64ace877");
  expect(fs.readdirSync(dir).some((f) => f.endsWith(".lock"))).toBe(false);
});

test("concurrent processes posting DMs never lose a message", async () => {
  resumeDefaultTeam();
  const script = path.join(dir, "post.ts");
  const storePath = path.resolve(import.meta.dir, "store.ts");
  fs.writeFileSync(
    script,
    `import { postToDm } from ${JSON.stringify(storePath)};\n` +
      `const [bot, n] = process.argv.slice(2);\n` +
      `for (let i = 0; i < Number(n); i++) postToDm(bot, "user", bot + "-" + i);\n`,
  );
  const bots = ["lead", "eng", "research", "qa"];
  const procs = bots.map((b) =>
    Bun.spawn(["bun", "run", script, b, "15"], {
      env: { ...process.env, HERDR_BOT_STATE_DIR: dir },
      stdout: "ignore",
      stderr: "inherit",
    }),
  );
  expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0]);
  for (const b of bots) {
    expect(getDm(b).map((m) => m.text)).toEqual(Array.from({ length: 15 }, (_, i) => `${b}-${i}`));
  }
}, 30000);

test("reply_to: set on replies when given, omitted otherwise, and old records without it still load", () => {
  resumeDefaultTeam();
  createChannel({ name: "standup" });
  const q = postToDm("lead", "user", "question");
  const a = postToDm("lead", "lead", "answer", { reply_to: q.id });
  expect(q.reply_to).toBeUndefined();
  expect("reply_to" in q).toBe(false);
  expect(a.reply_to).toBe(q.id);
  const team = loadOrSeedDefaultTeam();
  const t = postToDm(team, "lead", "lead", "team-form answer", { reply_to: q.id });
  expect(t.reply_to).toBe(q.id);
  expect(getDm("lead").map((m) => m.reply_to ?? null)).toEqual([null, q.id, q.id]);

  const post = postToChannel("standup", "user", "hi");
  const r = postToChannel("standup", "eng", "hey", { reply_to: post.id });
  expect(r.reply_to).toBe(post.id);
  expect(loadOrSeedDefaultTeam().channels[0].messages.map((m) => m.reply_to ?? null)).toEqual([null, post.id]);

  // Backward compat: a record written before reply_to existed.
  const legacy = loadOrSeedDefaultTeam();
  legacy.dms!.lead.push({ id: "msg_old", from_bot_id: "lead", text: "old reply", created_at: 1 });
  saveTeam(legacy);
  const old = getDm("lead").find((m) => m.id === "msg_old")!;
  expect(old.text).toBe("old reply");
  expect(old.reply_to).toBeUndefined();
});
