import { expect, test } from "bun:test";
import { installedBodyIds, parseIntegrationStatus } from "./integrations.ts";

const SAMPLE = `
pi: current (v8) (/Users/phoobobo/.pi/agent/extensions/herdr-agent-state.ts)
omp: current (v8) (/Users/phoobobo/.omp/agent/extensions/herdr-omp-agent-state.ts)
claude: outdated (v7 < v8) (/Users/phoobobo/.claude/hooks/herdr-agent-state.sh)
codex: outdated (v7 < v8) (/Users/phoobobo/.codex/herdr-agent-state.sh)
copilot: outdated (v2 < v3) (/Users/phoobobo/.copilot/hooks/herdr-agent-state.sh)
devin: not installed (/Users/phoobobo/.config/devin/herdr-agent-state.sh)
droid: not installed (/Users/phoobobo/.factory/hooks/herdr-agent-state.sh)
opencode: outdated (v9 < v10) (/Users/phoobobo/.config/opencode/plugins/herdr-agent-state.js)
hermes: outdated (v4 < v5) (/Users/phoobobo/.hermes/plugins/herdr-agent-state/__init__.py)
grok: current (v1) (/Users/phoobobo/.grok/hooks/herdr-agent-state.sh)
cursor: not installed (/Users/phoobobo/.cursor/herdr-agent-state.sh)
`;

test("skips not-installed integrations and keeps outdated ones", () => {
  const ids = installedBodyIds(parseIntegrationStatus(SAMPLE));
  expect(ids).toEqual(["pi", "omp", "claude", "codex", "copilot", "opencode", "hermes", "grok"]);
  expect(ids.includes("devin")).toBe(false);
  expect(ids.includes("cursor")).toBe(false);
});
