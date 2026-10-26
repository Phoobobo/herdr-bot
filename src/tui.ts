// Overlay TUI: Grok Bot layout — sidebar bots + channels, main 1:1 or #thread, composer.

import * as store from "./store.ts";
import { sendComposer } from "./spawn.ts";
import type { Bot, Channel, Team } from "./types.ts";
import { DEFAULT_BODY } from "./types.ts";
import { chatView, clampScroll, threadLayout, visibleRows } from "./view.ts";
import { InputParser, SGR, Screen, strWidth, truncate, type InputEvent } from "./ui.ts";

type Sel =
  | { kind: "bot"; index: number }
  | { kind: "channel"; index: number };

type Mode =
  | { kind: "normal" }
  | { kind: "prompt"; title: string; value: string; onSubmit: (v: string) => void };

let team: Team = store.resumeDefaultTeam();
let sel: Sel = { kind: "bot", index: 0 };
let mode: Mode = { kind: "normal" };
let draft = "";
let details = false;
let status = "";
let running = true;
let listW = 22;
/** Thread scroll: rows hidden below the viewport (0 = pinned to newest). */
let scroll = 0;
let lastThread = { total: 0, height: 1 };

const HINT = "n bot  c channel  i details  pgup/dn scroll  q quit";

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

function sidebarRows(): Array<{ y: number; sel: Sel }> {
  const rows: Array<{ y: number; sel: Sel }> = [];
  let y = 1;
  team.members.forEach((_, i) => {
    rows.push({ y, sel: { kind: "bot", index: i } });
    y++;
  });
  y += 2;
  team.channels.forEach((_, i) => {
    rows.push({ y, sel: { kind: "channel", index: i } });
    y++;
  });
  return rows;
}

function paintDetails(scr: Screen, dx: number, dw: number, h: number): void {
  const bot = selectedBot();
  const ch = selectedChannel();
  let y = 0;
  if (bot) {
    scr.text(dx, y, truncate(bot.name, dw), SGR.header, dw);
    y += 2;
    scr.text(dx, y, truncate(`tag  ${bot.tag}`, dw), SGR.app, dw);
    y++;
    scr.text(dx, y, truncate(`body ${bot.body}${(bot.body || "grok") === "grok" ? ` · model ${store.botModel(bot)}` : ""}`, dw), SGR.app, dw);
    y += 2;
    const desc = bot.description || "";
    for (const line of desc.split("\n")) {
      if (y >= h - 2) break;
      scr.text(dx, y, truncate(line, dw), SGR.app, dw);
      y++;
    }
  } else if (ch) {
    scr.text(dx, y, truncate(`#${ch.name}`, dw), SGR.header, dw);
    y += 2;
    const desc = ch.description || "";
    for (const line of desc.split("\n")) {
      if (y >= h - 2) break;
      scr.text(dx, y, truncate(line || "(no description)", dw), SGR.app, dw);
      y++;
    }
    if (!desc) {
      scr.text(dx, y, truncate("(no description)", dw), SGR.dim, dw);
    }
  }
  if (h > 3) {
    scr.text(dx, h - 2, truncate("esc closes details", dw), SGR.dim, dw);
  }
}

function paint(): void {
  const w = process.stdout.columns || 80;
  const h = process.stdout.rows || 24;
  listW = Math.min(22, Math.max(14, Math.min(22, w - 20)));
  const scr = new Screen(w, h);
  const view = chatView(team, sel);

  scr.fill(0, 0, w, h, " ", SGR.app);
  scr.fill(0, 0, listW, h, " ", SGR.sidebar);
  scr.fill(listW, h - 1, w - listW, 1, " ", SGR.composer);

  let y = 0;
  scr.text(1, y, "bots", SGR.sidebarDim, listW - 2);
  y++;
  view.sidebarBots.forEach((name, i) => {
    const active = sel.kind === "bot" && sel.index === i;
    const style = active ? SGR.selected : SGR.sidebar;
    if (active) scr.fill(0, y, listW, 1, " ", SGR.selected);
    if (y < h) scr.text(1, y, truncate(name, listW - 2), style, listW - 2);
    y++;
  });
  y++;
  if (y < h) scr.text(1, y, "channels", SGR.sidebarDim, listW - 2);
  y++;
  view.sidebarChannels.forEach((name, i) => {
    const active = sel.kind === "channel" && sel.index === i;
    const style = active ? SGR.selected : SGR.sidebar;
    if (active) scr.fill(0, y, listW, 1, " ", SGR.selected);
    if (y < h) scr.text(1, y, truncate(name, listW - 2), style, listW - 2);
    y++;
  });

  const dx = listW + 1;
  const dw = Math.max(1, w - listW - 2);

  if (details) {
    paintDetails(scr, dx, dw, h);
  } else {
    scr.text(dx, 0, truncate(view.header, dw), SGR.header, dw);
    // Full messages: newlines kept, long lines wrapped; the viewport scrolls.
    const cap = Math.max(1, h - 3);
    const rows = threadLayout(view.entries, dw);
    scroll = clampScroll(scroll, rows.length, cap);
    lastThread = { total: rows.length, height: cap };
    let ty = 2;
    for (const row of visibleRows(rows, cap, scroll)) {
      if (ty >= h - 1) break;
      scr.text(dx, ty, row.text, row.label ? SGR.dim : SGR.app, dw);
      ty++;
    }
    if (scroll > 0) {
      const more = `↓ ${scroll} more`;
      const mw = strWidth(more);
      const hw = strWidth(truncate(view.header, dw));
      if (hw + mw + 2 <= dw) scr.text(dx + dw - mw, 0, more, SGR.dim, mw);
    }
  }

  if (mode.kind === "prompt") {
    const line = `${mode.title}: ${mode.value}`;
    scr.text(listW + 1, h - 1, truncate(line, w - listW - 2), SGR.composer, w - listW - 2);
  } else {
    const line = `› ${draft}`;
    scr.text(listW + 1, h - 1, truncate(line, w - listW - 2), SGR.composer, w - listW - 2);
    if (!draft) {
      const hint = status || HINT;
      const start = listW + 1 + strWidth("› ") + 1;
      if (start + 8 < w) {
        scr.text(start, h - 1, truncate(hint, w - start - 1), SGR.composerDim, w - start - 1);
      }
    }
  }
  process.stdout.write(scr.render());
}

function prompt(title: string, onSubmit: (v: string) => void): void {
  mode = { kind: "prompt", title, value: "", onSubmit };
}

function deleteLastWord(s: string): string {
  const trimmed = s.replace(/\s+$/, "");
  const i = trimmed.lastIndexOf(" ");
  return i < 0 ? "" : trimmed.slice(0, i + 1);
}

function handlePrompt(ev: InputEvent): void {
  if (mode.kind !== "prompt") return;
  if (ev.type === "key" && ev.name === "ctrl-c") {
    running = false;
    return;
  }
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
    status = "";
    return;
  }
  if (ev.type === "key" && ev.name === "backspace") {
    mode.value = [...mode.value].slice(0, -1).join("");
    return;
  }
  if (ev.type === "key" && ev.name === "ctrl-u") {
    mode.value = "";
    return;
  }
  if (ev.type === "key" && ev.name === "ctrl-w") {
    mode.value = deleteLastWord(mode.value);
    return;
  }
  if (ev.type === "char") mode.value += ev.ch;
  if (ev.type === "paste") mode.value += ev.text;
}

function syncSelected(): void {
  // Replies are written by sendComposer after `agent prompt --wait`.
  // Do not screen-scrape (`agent read` / extractReplyFor) on the TUI path.
  reload();
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
  details = false;
  scroll = 0;
  syncSelected();
}

function selectRow(next: Sel): void {
  sel = next;
  details = false;
  scroll = 0;
  syncSelected();
}

function sendDraft(): void {
  const text = draft;
  if (!text.trim()) return;
  draft = "";
  scroll = 0;
  status = "sending...";
  void sendComposer(sel, text)
    .then(() => {
      status = "";
      reload();
      paint();
    })
    .catch((err) => {
      status = err instanceof Error ? err.message : String(err);
      paint();
    });
}

function scrollBy(delta: number): void {
  scroll = clampScroll(scroll + delta, lastThread.total, lastThread.height);
}

function handleMouse(ev: Extract<InputEvent, { type: "mouse" }>): void {
  if (ev.kind === "wheel-up" || ev.kind === "wheel-down") {
    if (ev.x >= listW && !details) scrollBy(ev.kind === "wheel-up" ? 3 : -3);
    return;
  }
  if (ev.kind !== "press" || ev.button !== 0) return;
  if (ev.x < listW) {
    const hit = sidebarRows().find((r) => r.y === ev.y);
    if (hit) selectRow(hit.sel);
    return;
  }
  if (ev.y === 0) {
    details = true;
  }
}

function handleNormal(ev: InputEvent): void {
  if (ev.type === "mouse") {
    handleMouse(ev);
    return;
  }
  if (ev.type === "key" && ev.name === "ctrl-c") {
    running = false;
    return;
  }
  if (ev.type === "key" && ev.name === "esc") {
    if (details) {
      details = false;
      return;
    }
    if (!draft) running = false;
    return;
  }
  if (details) {
    if (ev.type === "key" && (ev.name === "up" || ev.name === "down")) {
      move(ev.name === "down" ? 1 : -1);
    }
    return;
  }
  if (ev.type === "key" && ev.name === "down") move(1);
  if (ev.type === "key" && ev.name === "up") move(-1);
  if (ev.type === "key" && (ev.name === "pgup" || ev.name === "pgdn")) {
    const page = Math.max(1, lastThread.height - 1);
    scrollBy(ev.name === "pgup" ? page : -page);
    return;
  }
  if (ev.type === "key" && ev.name === "enter") {
    sendDraft();
    return;
  }
  if (ev.type === "key" && ev.name === "backspace") {
    draft = [...draft].slice(0, -1).join("");
    return;
  }
  if (ev.type === "key" && ev.name === "ctrl-u") {
    draft = "";
    return;
  }
  if (ev.type === "key" && ev.name === "ctrl-w") {
    draft = deleteLastWord(draft);
    return;
  }
  if (ev.type === "paste") {
    draft += ev.text;
    return;
  }
  if (ev.type !== "char") return;
  const k = ev.ch;
  if (!draft) {
    if (k === "q") {
      running = false;
      return;
    }
    if (k === "i") {
      details = true;
      return;
    }
    if (k === "n") {
      prompt("new bot", (name) => {
        store.createBot({ name, tag: "bot", description: "", body: DEFAULT_BODY });
        reload();
        sel = { kind: "bot", index: team.members.length - 1 };
      });
      return;
    }
    if (k === "c") {
      prompt("new channel", (name) => {
        store.createChannel(name);
        reload();
        sel = { kind: "channel", index: team.channels.length - 1 };
      });
      return;
    }
  }
  draft += k;
}

async function main(): Promise<void> {
  store.resumeDefaultTeam();
  reload();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const view = chatView(team, sel);
    process.stdout.write(`${view.header}\n`);
    for (const n of view.sidebarBots) process.stdout.write(`- ${n}\n`);
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h");
  const parser = new InputParser();
  const restore = () => {
    process.stdout.write("\x1b[?2004l\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
    try {
      process.stdin.setRawMode(false);
    } catch {
      // ignore
    }
  };
  process.on("exit", restore);
  paint();
  syncSelected();
  let escTimer: ReturnType<typeof setTimeout> | null = null;
  await new Promise<void>((resolve) => {
    const pump = (events: InputEvent[]) => {
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
    };
    process.stdin.on("data", (chunk: string) => {
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = null;
      }
      pump(parser.feed(chunk.toString()));
      if (!running) return;
      if (parser.hasPendingEscape()) {
        escTimer = setTimeout(() => pump(parser.flushEscape()), 40);
      }
    });
    process.stdout.on("resize", () => paint());
  });
}

if (import.meta.main) {
  await main();
}
