import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MEMBER_NAMES } from "./types.ts";

let dir: string;
let fakeHerdr: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-bot-cli-"));
  process.env.HERDR_BOT_STATE_DIR = dir;
  process.env.HERDR_BOT_BODIES = "pi,omp,claude,codex,copilot,opencode,hermes,grok";
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-bot-cli-bin-"));
  fakeHerdr = path.join(fakeDir, "herdr");
  // Isolate CLI tests from the live default session. channel post used to
  // `agent prompt --wait` real *-ch panes (and could hang once wait accepted done).
  fs.writeFileSync(
    fakeHerdr,
    "#!/bin/sh\necho '{\"id\":\"cli\",\"result\":{\"agents\":[],\"panes\":[],\"workspaces\":[],\"tabs\":[]}}'\n",
  );
  fs.chmodSync(fakeHerdr, 0o755);
});

afterEach(() => {
  delete process.env.HERDR_BOT_STATE_DIR;
  delete process.env.HERDR_BOT_BODIES;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.dirname(fakeHerdr), { recursive: true, force: true });
});

function cli(...args: string[]) {
  return Bun.spawnSync([process.execPath, "run", path.join(import.meta.dir, "cli.ts"), ...args], {
    env: {
      ...process.env,
      HERDR_BOT_STATE_DIR: dir,
      HERDR_BOT_BODIES: "pi,omp,claude,codex,copilot,opencode,hermes,grok",
      HERDR_BIN_PATH: fakeHerdr,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function json(proc: ReturnType<typeof cli>) {
  const text = proc.stdout.toString() || proc.stderr.toString();
  return JSON.parse(text);
}

test("QA gate: herdr-bots bots list --json returns exactly the four names", () => {
  const listed = cli("bots", "list", "--json");
  expect(listed.exitCode).toBe(0);
  const body = json(listed);
  expect(body.ok).toBe(true);
  expect(body.members).toEqual([...DEFAULT_MEMBER_NAMES]);
  expect(body.bots.map((b: { name: string }) => b.name)).toEqual([...DEFAULT_MEMBER_NAMES]);
  expect(body.members).toHaveLength(4);
});

test("herdr-bots team show --json exposes session default and four members", () => {
  const shown = cli("team", "show", "--json");
  expect(shown.exitCode).toBe(0);
  const body = json(shown);
  expect(body.team.session).toBe("default");
  expect(body.team.members).toEqual([...DEFAULT_MEMBER_NAMES]);
  expect(body.team.bots).toHaveLength(4);
});

test("resume --no-open seeds without opening a TUI", () => {
  const resumed = cli("resume", "--no-open", "--json");
  expect(resumed.exitCode).toBe(0);
  const body = json(resumed);
  expect(body.ok).toBe(true);
  expect(body.opened).toBe(false);
  expect(body.team.members).toEqual([...DEFAULT_MEMBER_NAMES]);
});

test("herdr-bots with no args / bots still resume", () => {
  const bare = cli("--no-open", "--json");
  expect(bare.exitCode).toBe(0);
  const bareBody = json(bare);
  expect(bareBody.ok).toBe(true);
  expect(bareBody.opened).toBe(false);
  expect(bareBody.members).toEqual([...DEFAULT_MEMBER_NAMES]);

  const bots = cli("bots", "--no-open", "--json");
  expect(bots.exitCode).toBe(0);
  const botsBody = json(bots);
  expect(botsBody.ok).toBe(true);
  expect(botsBody.opened).toBe(false);
  expect(botsBody.members).toEqual([...DEFAULT_MEMBER_NAMES]);
});

test("CLI create / rename / tag / description / body / channel --json", () => {
  const created = json(cli("bots", "create", "--name", "观察员", "--tag", "watch", "--body", "omp", "--json"));
  expect(created.bot.body).toBe("omp");
  expect(json(cli("bots", "rename", "观察员", "--name", "值班观察员", "--json")).bot.name).toBe("值班观察员");
  expect(json(cli("bots", "tag", "值班观察员", "--tag", "duty", "--json")).bot.tag).toBe("duty");
  expect(json(cli("bots", "description", "值班观察员", "--description", "on duty", "--json")).bot.description).toBe("on duty");
  expect(json(cli("bots", "body", "值班观察员", "--body", "grok", "--json")).bot.body).toBe("grok");
  const ch = json(cli("channel", "create", "--name", "standup", "--json"));
  expect(ch.channel.name).toBe("standup");
  const posted = json(cli("channel", "post", "standup", "--from", "lead", "--text", "hello", "--json"));
  expect(posted.message.text).toBe("hello");
});

test("CLI uses nonzero exits and JSON error codes", () => {
  const missing = cli("bots", "rename", "no-such-bot", "--name", "x", "--json");
  expect(missing.exitCode).toBe(3);
  expect(json(missing).error.code).toBe("BOT_NOT_FOUND");
});

test("CLI set body to omp stays omp after reload", () => {
  const set = cli("bots", "body", "研发工程师", "--body", "omp", "--json");
  expect(set.exitCode).toBe(0);
  expect(json(set).bot.body).toBe("omp");
  const listed = json(cli("bots", "list", "--json"));
  const eng = listed.bots.find((b: { name: string }) => b.name === "研发工程师");
  expect(eng.body).toBe("omp");
});
