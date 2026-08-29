// Spawn herdr CLI (HERDR_BIN_PATH ?? herdr) and a newline-delimited JSON
// socket helper. Default team always talks to session `default`.

import net from "node:net";
import os from "node:os";
import path from "node:path";

export const DEFAULT_SESSION = "default";
export const PLUGIN_ID = "phoobobo.herdr-bot";

export class HerdrApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrApiError";
    this.code = code;
  }
}

export function herdrBin(): string {
  const p = process.env.HERDR_BIN_PATH?.trim();
  return p && p.length > 0 ? p : "herdr";
}

export function socketPath(session = DEFAULT_SESSION): string {
  // Always compute from the session name. Do not inherit HERDR_SOCKET_PATH
  // (a taya pane would otherwise point this plugin at the wrong session).
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  if (session === DEFAULT_SESSION) {
    return path.join(config, "herdr", "herdr.sock");
  }
  return path.join(config, "herdr", "sessions", session, "herdr.sock");
}

/** Env for CLI / socket calls. Default team always sets HERDR_SESSION=default. */
export function herdrEnv(session = DEFAULT_SESSION): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.HERDR_SESSION = session;
  env.HERDR_SOCKET_PATH = socketPath(session);
  return env;
}

export async function runHerdr(
  args: string[],
  opts: { session?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const session = opts.session ?? DEFAULT_SESSION;
  const proc = Bun.spawn([herdrBin(), ...args], {
    env: herdrEnv(session),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

let reqSeq = 0;

export function request<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  opts: { session?: string } = {},
): Promise<T> {
  const session = opts.session ?? DEFAULT_SESSION;
  return new Promise((resolve, reject) => {
    const id = `bot:${process.pid}:${++reqSeq}`;
    const sock = net.createConnection(socketPath(session));
    let buf = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      fn();
    };
    sock.setTimeout(15_000, () => finish(() => reject(new Error(`herdr: timeout on ${method}`))));
    sock.on("error", (err) => finish(() => reject(err)));
    sock.on("close", () => finish(() => reject(new Error(`herdr: connection closed during ${method}`))));
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id, method, params }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      finish(() => {
        try {
          const msg = JSON.parse(line);
          if (msg.error) {
            reject(new HerdrApiError(msg.error.code ?? "unknown", msg.error.message ?? "herdr error"));
          } else {
            resolve(msg.result as T);
          }
        } catch (err) {
          reject(err as Error);
        }
      });
    });
  });
}
