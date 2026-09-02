import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MEMBER_NAMES } from "./types.ts";

const pluginBin = path.resolve(import.meta.dir, "../bin");
const dispatcher = path.join(pluginBin, "herdr");

let stateDir: string;
let fakeBin: string;
let isolatedPath: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-bot-dispatch-"));
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-official-"));
  const fakeHerdr = path.join(fakeBin, "herdr");
  fs.writeFileSync(fakeHerdr, "#!/bin/sh\necho \"OFFICIAL $*\"\n");
  fs.chmodSync(fakeHerdr, 0o755);
  isolatedPath = [pluginBin, fakeBin, process.env.PATH || ""].join(":");
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(fakeBin, { recursive: true, force: true });
});

function dispatchEnv() {
  return {
    ...process.env,
    PATH: isolatedPath,
    HERDR_BOT_STATE_DIR: stateDir,
    HERDR_BOT_BODIES: "pi,omp,claude,codex,copilot,opencode,hermes,grok",
  };
}

function dispatch(...args: string[]) {
  return Bun.spawnSync(["herdr", ...args], {
    env: dispatchEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
}

// Local-dev only. Plugin install does not put bin/herdr on PATH; that is not a
// product fail. User entry is `herdr plugin action invoke phoobobo.herdr-bot.bots`
// (or a [[keys.command]] type = "plugin_action" keybind).
test("command -v herdr with plugin bin first resolves to the dispatcher", () => {
  const which = Bun.spawnSync(["sh", "-c", "command -v herdr"], {
    env: dispatchEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(which.exitCode).toBe(0);
  const resolved = which.stdout.toString().trim();
  expect(resolved).toBe(dispatcher);
  expect(resolved).not.toBe(path.join(os.homedir(), ".local/bin/herdr"));
});

test("local-dev herdr bots --no-open --json via dispatcher resumes the default four members", () => {
  const proc = dispatch("bots", "--no-open", "--json");
  expect(proc.exitCode).toBe(0, proc.stderr.toString() || proc.stdout.toString());
  const body = JSON.parse(proc.stdout.toString() || proc.stderr.toString());
  expect(body.ok).toBe(true);
  expect(body.opened).toBe(false);
  expect(body.members).toEqual([...DEFAULT_MEMBER_NAMES]);
  expect(body.members).toHaveLength(4);
});

test("herdr session list through dispatcher execs official herdr", () => {
  const proc = dispatch("session", "list");
  expect(proc.exitCode).toBe(0, proc.stderr.toString());
  expect(proc.stdout.toString()).toBe("OFFICIAL session list\n");
});

test("herdr not-bots through dispatcher is not swallowed", () => {
  const proc = dispatch("not-bots");
  expect(proc.exitCode).toBe(0, proc.stderr.toString());
  expect(proc.stdout.toString()).toBe("OFFICIAL not-bots\n");
});
