/**
 * Entire Checkpoint adapter -- the "why", which a diff structurally cannot hold.
 *
 * `entire checkpoint` is read-only (list, explain, tokens, search). Checkpoints
 * are minted by the hooks `entire enable` installs, tied to commits.
 *
 * Trap extraction is KEYWORD-BASED, deliberately, not LLM-based. Chosen for
 * determinism (same input -> same output, byte for byte), offline operation,
 * and because "how do you know that is a risk?" has a one-line answer we can
 * point at. The cost is recall: an open risk phrased unusually is missed, and
 * we disclose that rather than hide it.
 */
import { parseJson, runCommand } from "./exec.js";
import type { KnownTrap, Provenance } from "../types.js";

/** Phrases that signal unresolved work, a deferral, or a prior failure. */
export const TRAP_KEYWORDS = [
  "todo", "deferred", "defer ", "unresolved", "known risk", "open risk",
  "failed", "did not", "does not yet", "revisit", "workaround", "hack",
  "not implemented", "left out", "skipped", "assumption", "fragile",
  "deadlock", "race condition", "breaks if",
];

export type CheckpointSummary = {
  id?: string;
  sha?: string;
  message?: string;
  title?: string;
  summary?: string;
  files?: string[];
  created_at?: string;
};

/** Pull whatever list shape the CLI gives us into a flat array. */
function coerceList(data: unknown): CheckpointSummary[] {
  if (Array.isArray(data)) return data as CheckpointSummary[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["checkpoints", "items", "results", "entries"]) {
      if (Array.isArray(obj[key])) return obj[key] as CheckpointSummary[];
    }
  }
  return [];
}

function idOf(c: CheckpointSummary): string {
  return c.id ?? c.sha ?? "unknown";
}

/** Every string field of an explain payload, flattened, for keyword scanning. */
function collectText(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectText(v, out, depth + 1);
  else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectText(v, out, depth + 1);
    }
  }
  return out;
}

/** Any path-looking string in the payload, so we can intersect with the radius. */
function collectPaths(value: unknown): string[] {
  const paths = new Set<string>();
  for (const s of collectText(value)) {
    for (const m of s.matchAll(/[\w./-]+\.[A-Za-z0-9]{1,6}/g)) {
      const p = m[0];
      if (p.includes("/") || p.includes(".")) paths.add(p.split("\\").join("/"));
    }
  }
  return [...paths];
}

export type TrapEvidence = {
  traps: KnownTrap[];
  degraded: string[];
  provenance: Provenance[];
};

/**
 * Read recent checkpoints and keep those that both (a) contain a trap keyword
 * and (b) touch a file inside the blast radius. Both conditions, so we do not
 * dump the whole history at the agent as "risks".
 */
export async function knownTraps(
  cwd: string,
  radius: Set<string>,
  limit = 12,
): Promise<TrapEvidence> {
  const listCmd = await runCommand("entire", ["checkpoint", "list", "--json"], { cwd });
  const provenance: Provenance[] = [
    { source: "checkpoint", command: listCmd.command, confidence: "heuristic" },
  ];
  const degraded: string[] = [];

  if (!listCmd.ok) {
    degraded.push(
      `checkpoint list failed (${listCmd.error}); traps not assessed -- the contract rests on graph evidence alone`,
    );
    return { traps: [], degraded, provenance };
  }

  const list = coerceList(parseJson(listCmd));
  if (list.length === 0) {
    degraded.push(
      "no checkpoint history on this branch -- prior decisions and deferred work were not assessed",
    );
    return { traps: [], degraded, provenance };
  }

  const traps: KnownTrap[] = [];
  for (const entry of list.slice(0, limit)) {
    const id = idOf(entry);
    if (id === "unknown") continue;
    const explain = await runCommand(
      "entire",
      ["checkpoint", "explain", id, "--json"],
      { cwd },
    );
    provenance.push({
      source: "checkpoint",
      command: explain.command,
      confidence: "heuristic",
    });
    if (!explain.ok) {
      degraded.push(`checkpoint explain ${id} failed: ${explain.error}`);
      continue;
    }
    const payload = parseJson(explain) ?? explain.stdout;
    const files = collectPaths(payload);
    // Only surface a trap if it lands inside the radius we are guarding.
    const intersecting = files.filter((f) => radius.has(f));
    if (intersecting.length === 0) continue;

    for (const line of collectText(payload).flatMap((s) => s.split(/\r?\n/))) {
      const text = line.trim();
      if (text.length < 12 || text.length > 400) continue;
      const lower = text.toLowerCase();
      const hit = TRAP_KEYWORDS.find((k) => lower.includes(k));
      if (!hit) continue;
      traps.push({
        text,
        checkpoint_id: id,
        files: intersecting,
        provenance: {
          source: "checkpoint",
          command: explain.command,
          confidence: "heuristic",
        },
      });
      break; // one trap per checkpoint keeps the brief readable
    }
  }

  if (traps.length === 0) {
    degraded.push(
      "checkpoints were read but none mentioned unresolved work inside this blast radius (keyword extraction; unusual phrasing is missed by design)",
    );
  }
  return { traps, degraded, provenance };
}
