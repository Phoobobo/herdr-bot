// Parse `herdr integration status` for available agent bodies.
// Lines containing "not installed" are skipped. Default body is `pi`.

import { herdrBin, herdrEnv, runHerdr } from "./herdr.ts";
import { DEFAULT_BODY } from "./types.ts";

export { DEFAULT_BODY };

export interface IntegrationRow {
  id: string;
  status: string;
  raw: string;
}

export function parseIntegrationStatus(stdout: string): IntegrationRow[] {
  const rows: IntegrationRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    rows.push({ id: m[1], status: m[2], raw: trimmed });
  }
  return rows;
}

export function installedBodyIds(rows: IntegrationRow[]): string[] {
  return rows
    .filter((r) => !/\bnot installed\b/i.test(r.raw))
    .map((r) => r.id);
}

/** HERDR_BOT_BODIES overrides (comma/space list) so tests do not spawn herdr. */
export function listInstalledBodiesSync(): string[] {
  const override = process.env.HERDR_BOT_BODIES?.trim();
  if (override) return override.split(/[,\s]+/).filter(Boolean);
  try {
    const proc = Bun.spawnSync([herdrBin(), "integration", "status"], {
      env: herdrEnv(),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    if (proc.exitCode !== 0) return [DEFAULT_BODY];
    const ids = installedBodyIds(parseIntegrationStatus(proc.stdout.toString()));
    return ids.length ? ids : [DEFAULT_BODY];
  } catch {
    return [DEFAULT_BODY];
  }
}

export async function availableBodies(session = "default"): Promise<string[]> {
  const override = process.env.HERDR_BOT_BODIES?.trim();
  if (override) return override.split(/[,\s]+/).filter(Boolean);
  const { stdout, exitCode } = await runHerdr(["integration", "status"], { session });
  if (exitCode !== 0) return [DEFAULT_BODY];
  const ids = installedBodyIds(parseIntegrationStatus(stdout));
  return ids.length ? ids : [DEFAULT_BODY];
}

export function assertBodyInstalled(body: string): string {
  const name = body.trim();
  const available = listInstalledBodiesSync();
  if (!available.includes(name)) {
    throw new Error(`unknown or not-installed body: ${name}`);
  }
  return name;
}

export function resolveBody(requested: string | undefined): string {
  if (requested && requested.trim()) return assertBodyInstalled(requested);
  const available = listInstalledBodiesSync();
  if (available.includes(DEFAULT_BODY)) return DEFAULT_BODY;
  return DEFAULT_BODY;
}
