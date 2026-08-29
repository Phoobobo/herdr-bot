// Overlay TUI: left bot list, main detail, header team+session.
// Keys: j/k select, n new bot, c new channel, e edit, q quit.

import * as store from "./store.ts";
import { deliverChannelPost, openBot } from "./spawn.ts";
import type { Bot, Channel, Team } from "./types.ts";
import { DEFAULT_BODY } from "./types.ts";
import { InputParser, SGR, Screen, truncate, type InputEvent } from "./ui.ts";

type Sel =
  | { kind: "bot"; index: number }
  | { kind: "channel"; index: number };

type Mode =
  | { kind: "normal" }
  | { kind: "prompt"; title: string; value: string; onSubmit: (v: string) => void };

let team: Team = store.resumeDefaultTeam();
let sel: Sel = { kind: "bot", index: 0 };
let mode: Mode = { kind: "normal" };
let status = "j/k select   enter open   n new bot   c new channel   e edit   t tag   d desc   b body   m post   q quit";
let running = true;

function reload(): void {
  team = store.loadOrSeedDefaultTeam();
  if (sel.kind === "bot" && sel.index >= team.members.length) {
    sel = { kind: "bot", index: Math.max(0, team.members.length - 1) };
  }
  if (sel.kind === "channel" && sel.index >= team.channels.length) {
    sel = team.channels.length
      ? { kind: "channel", index: team.channels.length - 1 }
      : { kind: "bot", index: 0 };
  }
}

function selectedBot(): Bot | undefined {
  return sel.kind === "bot" ? team.members[sel.index] : undefined;
}

function selectedChannel(): Channel | undefined {
  return sel.kind === "channel" ? team.channels[sel.index] : undefined;
}

function paint(): void {
  const w = process.stdout.columns || 80;
  const h = process.stdout.rows || 24;
  const scr = new Screen(w, h);
  const listW = Math.min(28, Math.max(18, Math.floor(w * 0.32)));
  const header = ` herdr-bot   team: ${team.name}   session: ${team.session} `;
  scr.fill(0, 0, w, 1, " ", SGR.headerBg + SGR.accentBold);
  scr.text(0, 0, truncate(header, w), SGR.headerBg + SGR.accentBold, w);

  scr.box(0, 1, listW, h - 2, SGR.border);
  scr.box(listW, 1, w - listW, h - 2, SGR.border);
  scr.text(2, 1, " bots ", SGR.dim);

  let y = 2;
  team.members.forEach((bot, i) => {
    const active = sel.kind === "bot" && sel.index === i;
    const style = active ? SGR.inverse : SGR.text;
    const mark = active ? ">" : " ";
    scr.text(1, y, truncate(`${mark} ${bot.name}`, listW - 2), style, listW - 2);
    y++;
  });
  if (team.channels.length) {
    y++;
    if (y < h - 2) scr.text(2, y, " channels ", SGR.dim);
    y++;
    team.channels.forEach((ch, i) => {
      const active = sel.kind === "channel" && sel.index === i;
      const style = active ? SGR.inverse : SGR.text;
      const mark = active ? ">" : " ";
      if (y < h - 2) scr.text(1, y, truncate(`${mark} #${ch.name}`, listW - 2), style, listW - 2);
      y++;
    });
  }

  const dx = listW + 2;
  const dw = w - listW - 3;
  const bot = selectedBot();
  const ch = selectedChannel();
  if (bot) {
    scr.text(dx, 2, truncate(bot.name, dw), SGR.accentBold, dw);
    scr.text(dx, 3, truncate(`tag: ${bot.tag}    body: ${bot.body}`, dw), SGR.dim, dw);
    scr.text(dx, 5, truncate(bot.description, dw), SGR.text, dw);
  } else if (ch) {
    scr.text(dx, 2, truncate(`#${ch.name}`, dw), SGR.accentBold, dw);
    let my = 4;
    for (const msg of ch.messages.slice(-Math.max(1, h - 8))) {
      const from = team.members.find((b) => b.id === msg.from_bot_id)?.name ?? msg.from_bot_id;
      scr.text(dx, my, truncate(`${from}: ${msg.text}`, dw), SGR.text, dw);
      my++;
      if (my >= h - 3) break;
    }
  }

  const footer = mode.kind === "prompt" ? ` ${mode.title}: ${mode.value}` : ` ${status}`;
  const fstyle = mode.kind === "prompt" ? SGR.green : SGR.dim;
  scr.fill(0, h - 1, w, 1, " ", fstyle);
  scr.text(0, h - 1, truncate(footer, w), fstyle, w);
  process.stdout.write(scr.render());
}

function prompt(title: string, onSubmit: (v: string) => void): void {
  mode = { kind: "prompt", title, value: "", onSubmit };
}

function handlePrompt(ev: InputEvent): void {
  if (mode.kind !== "prompt") return;
  if (ev.type === "key" && ev.name === "enter") {
    const v = mode.value.trim();
    const fn = mode.onSubmit;
    mode = { kind: "normal" };
    if (v) {
      try {
        fn(v);
        status = "ok";
      } catch (err) {
        status = err instanceof Error ? err.message : String(err);
      }
    }
    reload();
    return;
  }
  if (ev.type === "key" && ev.name === "esc") {
    mode = { kind: "normal" };
    status = "cancelled";
    return;
  }
  if (ev.type === "key" && ev.name === "backspace") {
    mode.value = [...mode.value].slice(0, -1).join("");
    return;
  }
  if (ev.type === "char") mode.value += ev.ch;
  if (ev.type === "paste") mode.value += ev.text;
}

function move(delta: number): void {
  const items: Sel[] = [
    ...team.members.map((_, i) => ({ kind: "bot" as const, index: i })),
    ...team.channels.map((_, i) => ({ kind: "channel" as const, index: i })),
  ];
  if (!items.length) return;
  const cur = items.findIndex((it) => it.kind === sel.kind && it.index === sel.index);
  const next = (cur + delta + items.length) % items.length;
  sel = items[next];
}

function handleNormal(ev: InputEvent): void {
  if (ev.type === "key" && (ev.name === "ctrl-c" || ev.name === "esc")) {
    running = false;
    return;
  }
  if (ev.type === "key" && ev.name === "down") move(1);
  if (ev.type === "key" && ev.name === "up") move(-1);
  if (ev.type === "key" && ev.name === "enter") {
    const bot = selectedBot();
    if (!bot) return;
    status = `starting ${bot.name} (${bot.body})...`;
    void openBot(bot.id)
      .then(() => {
        status = `${bot.name} live`;
        reload();
      })
      .catch((err) => {
        status = err instanceof Error ? err.message : String(err);
      });
    return;
  }
  if (ev.type !== "char") return;
  const k = ev.ch;
  if (k === "q") {
    running = false;
    return;
  }
  if (k === "j") move(1);
  if (k === "k") move(-1);
  if (k === "n") {
    prompt("new bot name", (name) => {
      store.createBot({ name, tag: "bot", description: "", body: DEFAULT_BODY });
    });
  }
  if (k === "c") {
    prompt("new channel name", (name) => {
      store.createChannel(name);
    });
  }
  if (k === "e" || k === "d") {
    const bot = selectedBot();
    if (!bot) return;
    prompt(`description (${bot.name})`, (description) => {
      store.setDescription(bot.id, description);
    });
  }
  if (k === "t") {
    const bot = selectedBot();
    if (!bot) return;
    prompt(`tag (${bot.name})`, (tag) => {
      store.setTag(bot.id, tag);
    });
  }
  if (k === "b") {
    const bot = selectedBot();
    if (!bot) return;
    prompt(`body (${bot.name})`, (body) => {
      store.setBody(bot.id, body);
    });
  }
  if (k === "m") {
    const ch = selectedChannel();
    if (!ch) {
      status = "select a channel to post";
      return;
    }
    prompt(`post as (bot id/name)`, (from) => {
      prompt("message", (text) => {
        store.postToChannel(ch.id, from, text);
        status = "delivering...";
        void deliverChannelPost(ch.id, from, text)
          .then((d) => {
            status = `delivered ${d.delivered.length} live pane(s)`;
            reload();
          })
          .catch((err) => {
            status = err instanceof Error ? err.message : String(err);
          });
      });
    });
  }
  if (k === "?") {
    status = "j/k n new-bot  c new-channel  e/d desc  t tag  b body  m post  q quit";
  }
}

async function main(): Promise<void> {
  store.resumeDefaultTeam();
  reload();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(`herdr-bot  team: ${team.name}  session: ${team.session}\n`);
    for (const n of store.memberNames(team)) process.stdout.write(`- ${n}\n`);
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  const parser = new InputParser();
  const restore = () => {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    try {
      process.stdin.setRawMode(false);
    } catch {
      // ignore
    }
  };
  process.on("exit", restore);
  paint();
  await new Promise<void>((resolve) => {
    process.stdin.on("data", (chunk: string) => {
      const events = parser.feed(chunk.toString());
      for (const ev of events) {
        if (mode.kind === "prompt") handlePrompt(ev);
        else handleNormal(ev);
      }
      if (!running) {
        restore();
        resolve();
        return;
      }
      paint();
    });
    process.stdout.on("resize", () => paint());
  });
}

if (import.meta.main) {
  await main();
}
