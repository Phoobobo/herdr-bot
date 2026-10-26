// herdr-bots CLI.

import { openDefaultOverlay } from "./actions.ts";
import * as store from "./store.ts";
import { deliverChannelPost, deliverDmPost, ensureTeamLive, listLiveBots, openBot } from "./spawn.ts";
import { syncChannelReplies, threadLines } from "./thread.ts";
import { listInstalledBodiesSync, resolveBody } from "./integrations.ts";
import { BotError, USER_ID, type Team } from "./types.ts";

function usage(): string {
  return `herdr-bots — one team, one Herdr session

Usage:
  herdr-bots [--json] [--no-open]
  herdr-bots bots
  herdr-bots bots list --json
  herdr-bots resume [--no-open] [--json]
  herdr-bots team show --json
  herdr-bots bots create --name <name> [--tag t] [--description d] [--body grok|pi] [--model grok-4.7]
  herdr-bots bots rename <id|name> --name <name>
  herdr-bots bots tag <id|name> --tag <tag>
  herdr-bots bots description <id|name> --description <text>
  herdr-bots bots body <id|name> --body <harness>      (grok default; pi optional)
  herdr-bots bots model <id|name> --model <grok model> (checked against \`grok models\` at start)
  herdr-bots bots open <id|name> [--json]
  herdr-bots bots up [--json]
  herdr-bots bots live --json
  herdr-bots bot create|rename|tag|description|body|model|open   (alias of bots *)
  herdr-bots dm <id|name> --text <text> [--json]       (1:1 DM, same path as the TUI composer)
  herdr-bots channel create --name <name>
  herdr-bots channel post <channel> --from <bot> --text <text>
  herdr-bots channel sync <channel> [--json]
  herdr-bots channel show <channel> [--json]
  herdr-bots bodies list --json
`;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  return undefined;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (a === "--json" || a === "--no-open" || a === "--help" || a === "-h") continue;
      if (!a.includes("=") && i + 1 < args.length && !args[i + 1].startsWith("--")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function teamPayload(team: Team) {
  const names = store.memberNames(team);
  return {
    ...team,
    session: team.session,
    members: names,
    bots: team.members,
  };
}

function exitFor(err: BotError): number {
  if (err.code === "BOT_NOT_FOUND") return 3;
  if (err.code === "CHANNEL_NOT_FOUND") return 3;
  return 1;
}

function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function resume(args: string[]): Promise<number> {
  const team = store.resumeDefaultTeam();
  const noOpen = hasFlag(args, "no-open");
  const jsonMode = hasFlag(args, "json");
  if (!noOpen) {
    await openDefaultOverlay();
  }
  if (jsonMode) {
    const names = store.memberNames(team);
    writeJson({
      ok: true,
      opened: !noOpen,
      members: names,
      names,
      session: team.session,
      team: teamPayload(team),
    });
  } else if (noOpen) {
    process.stdout.write(`team ${team.id} session ${team.session} members: ${store.memberNames(team).join(", ")}\n`);
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help") || argv[0] === "help") {
    process.stdout.write(usage());
    return 0;
  }
  try {
    const cmd = argv[0];
    const jsonMode = hasFlag(argv, "json");

    // bare: resume default team (+ overlay unless --no-open)
    if (!cmd || cmd.startsWith("--")) {
      return await resume(argv);
    }

    if (cmd === "resume") {
      return await resume(argv);
    }

    if (cmd === "team") {
      if (argv[1] === "show") {
        const team = store.resumeDefaultTeam();
        writeJson({ ok: true, team: teamPayload(team) });
        return 0;
      }
      throw new BotError("BAD_REQUEST", "usage: herdr-bots team show --json");
    }

    if (cmd === "bodies") {
      const ids = listInstalledBodiesSync();
      writeJson({ ok: true, bodies: ids });
      return 0;
    }

    if (cmd === "bots" || cmd === "bot") {
      const sub = argv[1];
      const rest = argv.slice(cmd === "bots" || cmd === "bot" ? 2 : 1);
      // `herdr-bots bots` with no subcommand (or only flags) -> overlay
      if (!sub || sub.startsWith("--")) {
        return await resume(argv);
      }
      const team = store.resumeDefaultTeam();
      const pos = positionals(argv.slice(2));

      if (sub === "list") {
        writeJson({
          ok: true,
          members: store.memberNames(team),
          names: store.memberNames(team),
          bots: team.members,
        });
        return 0;
      }
      if (sub === "create") {
        const name = flag(argv, "name") || pos[0];
        if (!name) throw new BotError("BAD_REQUEST", "usage: herdr-bots bots create --name <name>");
        const bot = store.createBot({
          name,
          tag: flag(argv, "tag"),
          description: flag(argv, "description") || flag(argv, "desc"),
          body: resolveBody(flag(argv, "body")),
          model: flag(argv, "model"),
        });
        writeJson({ ok: true, bot });
        return 0;
      }
      if (sub === "rename") {
        const target = pos[0];
        const name = flag(argv, "name") || pos[1];
        if (!target || !name) throw new BotError("BAD_REQUEST", "usage: herdr-bots bots rename <id|name> --name <name>");
        const bot = store.renameBot(target, name);
        writeJson({ ok: true, bot });
        return 0;
      }
      if (sub === "tag") {
        const target = pos[0];
        const tag = flag(argv, "tag") || pos[1];
        if (!target || tag === undefined) throw new BotError("BAD_REQUEST", "usage: herdr-bots bots tag <id|name> --tag <tag>");
        const bot = store.setTag(target, tag);
        writeJson({ ok: true, bot });
        return 0;
      }
      if (sub === "description") {
        const target = pos[0];
        const description = flag(argv, "description") || flag(argv, "desc") || pos.slice(1).join(" ");
        if (!target || !description) throw new BotError("BAD_REQUEST", "usage: herdr-bots bots description <id|name> --description <text>");
        const bot = store.setDescription(target, description);
        writeJson({ ok: true, bot });
        return 0;
      }
      if (sub === "body") {
        const target = pos[0];
        const body = flag(argv, "body") || pos[1];
        if (!target || !body) throw new BotError("BAD_REQUEST", "usage: herdr-bots bots body <id|name> --body <harness>");
        const bot = store.setBody(target, resolveBody(body));
        writeJson({ ok: true, bot });
        return 0;
      }
      if (sub === "model") {
        const target = pos[0];
        const model = flag(argv, "model") || pos[1];
        if (!target || !model) throw new BotError("BAD_REQUEST", "usage: herdr-bots bots model <id|name> --model <id>");
        const bot = store.setModel(target, model);
        writeJson({ ok: true, bot });
        return 0;
      }
      if (sub === "open") {
        const target = pos[0] || flag(argv, "name");
        if (!target) throw new BotError("BAD_REQUEST", "usage: herdr-bots bots open <id|name>");
        const bot = await openBot(target);
        writeJson({ ok: true, bot });
        return 0;
      }
      if (sub === "up") {
        const members = await ensureTeamLive();
        writeJson({ ok: true, session: "default", members, names: members.map((m) => m.name) });
        return 0;
      }
      if (sub === "live") {
        const members = await listLiveBots();
        writeJson({
          ok: true,
          session: "default",
          members,
          names: members.filter((m) => m.live).map((m) => m.name),
          live: members.every((m) => m.live),
        });
        return 0;
      }
      throw new BotError("BAD_REQUEST", "usage: herdr-bots bots list|create|rename|tag|description|body|model|open|up|live");
    }

    if (cmd === "dm") {
      const pos = positionals(argv.slice(1));
      const target = pos[0] || flag(argv, "to");
      const text = flag(argv, "text");
      if (!target || !text?.trim()) throw new BotError("BAD_REQUEST", "usage: herdr-bots dm <id|name> --text <text>");
      const team = store.resumeDefaultTeam();
      const bot = store.findBot(team, target);
      const message = store.postToDm(bot.id, USER_ID, text);
      await deliverDmPost(bot.id, text, message.id);
      const thread = store.resumeDefaultTeam().dms?.[bot.id] ?? [];
      // Match by reply_to so a concurrent DM's reply is never reported as ours.
      const reply = thread.find((m) => m.from_bot_id === bot.id && m.reply_to === message.id) ?? null;
      writeJson({ ok: true, bot: bot.id, message, reply });
      return 0;
    }

    if (cmd === "channel") {
      const sub = argv[1];
      const team = store.resumeDefaultTeam();
      const pos = positionals(argv.slice(2));
      if (sub === "list") {
        writeJson({ ok: true, channels: team.channels });
        return 0;
      }
      if (sub === "create") {
        const name = flag(argv, "name") || pos[0];
        if (!name) throw new BotError("BAD_REQUEST", "usage: herdr-bots channel create --name <name>");
        const channel = store.createChannel({ name, description: flag(argv, "description") });
        writeJson({ ok: true, channel });
        return 0;
      }
      if (sub === "post") {
        const channel = pos[0];
        const from = flag(argv, "from");
        const text = flag(argv, "text");
        if (!channel || !from || !text) {
          throw new BotError("BAD_REQUEST", "usage: herdr-bots channel post <channel> --from <bot> --text <text>");
        }
        const message = store.postToChannel(channel, from, text);
        const delivery = await deliverChannelPost(channel, from, text, message.id);
        writeJson({ ok: true, message, delivery });
        return 0;
      }
      if (sub === "sync" || sub === "show") {
        const channel = pos[0] || flag(argv, "name");
        if (!channel) throw new BotError("BAD_REQUEST", "usage: herdr-bots channel sync <channel>");
        const { channel: ch, added } = await syncChannelReplies(channel);
        writeJson({
          ok: true,
          channel: ch,
          added,
          thread: threadLines(team, ch),
        });
        return 0;
      }
      throw new BotError("BAD_REQUEST", "usage: herdr-bots channel create|post|list|sync|show");
    }

    throw new BotError("BAD_REQUEST", usage());
  } catch (err) {
    if (err instanceof BotError) {
      writeJson({ ok: false, error: { code: err.code, message: err.message } });
      return exitFor(err);
    }
    const message = err instanceof Error ? err.message : String(err);
    // Body errors from integrations may not be BotError
    if (/not-installed body|unknown/.test(message)) {
      writeJson({ ok: false, error: { code: "UNKNOWN_BODY", message } });
      return 1;
    }
    process.stderr.write(message + "\n");
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
