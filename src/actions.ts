// Plugin action entrypoint. herdr sets HERDR_PLUGIN_ACTION_ID; argv fallback
// keeps `bun run src/actions.ts bots` usable by hand.

import { DEFAULT_SESSION, runHerdr } from "./herdr.ts";
import * as store from "./store.ts";
import { resolveBody } from "./integrations.ts";
import { BotError } from "./types.ts";
import { openBot, openBotsTui } from "./spawn.ts";

function actionId(): string {
  return (process.env.HERDR_PLUGIN_ACTION_ID || process.argv[2] || "").trim();
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  return undefined;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (!a.includes("=") && i + 1 < args.length && !args[i + 1].startsWith("--")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Resume the default session (already running) and open the overlay TUI.
 * Does not call `herdr session attach` — that is a blocking client TUI.
 * HERDR_SESSION=default is set by runHerdr.
 */
export async function openDefaultOverlay(): Promise<void> {
  store.resumeDefaultTeam();
  await runHerdr(["session", "list"], { session: DEFAULT_SESSION }).catch(() => {});
  await openBotsTui();
}

export async function dispatch(id: string, args: string[]): Promise<void> {
  store.resumeDefaultTeam();
  const pos = positional(args);
  switch (id) {
    case "bots":
      await openDefaultOverlay();
      return;
    case "create-bot": {
      const name = flag(args, "name") || pos[0];
      if (!name) throw new BotError("BAD_REQUEST", "create-bot requires --name <name>");
      store.createBot({
        name,
        tag: flag(args, "tag") || pos[1],
        description: flag(args, "description") || flag(args, "desc") || pos[2],
        body: resolveBody(flag(args, "body") || pos[3]),
        model: flag(args, "model"),
      });
      return;
    }
    case "rename-bot":
    case "rename": {
      const from = flag(args, "from") || pos[0];
      const to = flag(args, "name") || flag(args, "to") || pos[1];
      if (!from || !to) throw new BotError("BAD_REQUEST", "rename-bot requires <from> --name <to>");
      store.renameBot(from, to);
      return;
    }
    case "set-tag":
    case "tag": {
      const name = flag(args, "name") || pos[0];
      const tag = flag(args, "tag") || pos[1];
      if (!name || tag === undefined) throw new BotError("BAD_REQUEST", "set-tag requires --name <name> --tag <tag>");
      store.setTag(name, tag);
      return;
    }
    case "set-description":
    case "description": {
      const name = flag(args, "name") || pos[0];
      const description = flag(args, "description") || flag(args, "desc") || pos.slice(1).join(" ");
      if (!name || !description) throw new BotError("BAD_REQUEST", "set-description requires --name and --description");
      store.setDescription(name, description);
      return;
    }
    case "set-body":
    case "body": {
      const name = flag(args, "name") || pos[0];
      const body = flag(args, "body") || pos[1];
      if (!name || !body) throw new BotError("BAD_REQUEST", "set-body requires --name and --body");
      store.setBody(name, resolveBody(body));
      return;
    }
    case "set-model":
    case "model": {
      const name = flag(args, "name") || pos[0];
      const model = flag(args, "model") || pos[1];
      if (!name || !model) throw new BotError("BAD_REQUEST", "set-model requires --name and --model");
      store.setModel(name, model);
      return;
    }
    case "create-channel": {
      const name = flag(args, "name") || pos[0];
      if (!name) throw new BotError("BAD_REQUEST", "create-channel requires --name <name>");
      store.createChannel(name);
      return;
    }
    case "open-bot": {
      const name = flag(args, "name") || pos[0];
      if (!name) throw new BotError("BAD_REQUEST", "open-bot requires --name <id|name>");
      await openBot(name);
      return;
    }
    default:
      throw new BotError("BAD_REQUEST", `unknown action: ${id || "(none)"}`);
  }
}

async function main(): Promise<number> {
  try {
    const id = actionId();
    const args = process.argv.slice(process.env.HERDR_PLUGIN_ACTION_ID ? 2 : 3);
    await dispatch(id, args);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
