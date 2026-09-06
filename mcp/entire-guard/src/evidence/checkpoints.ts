/**
 * Entire Checkpoint adapter -- the "why", which a diff structurally cannot hold.
 *
 * `entire checkpoint` is read-only (list, explain, tokens, search). Checkpoints
 * are minted by the hooks `entire enable` installs, tied to commits.
 *
 * FIELD SHAPES ARE PINNED AGAINST REAL OUTPUT (test/fixtures/checkpoints.json),
 * not assumed. An earlier version of this file guessed `id` / `sha` for the
 * identifier when the CLI actually emits `checkpoint_id`, so every checkpoint
 * was skipped and this feature silently returned nothing while reporting a
 * plausible degradation message. That is exactly the failure mode entire-guard
 * exists to catch, and it survived precisely because this shape was the one
 * thing never captured as a fixture.
 *
 * Two commands per checkpoint, because they carry different things:
 *   explain --json  -> `files_touched`, an authoritative file list.
 *   explain --full  -> the intent/summary prose. The JSON form has no text.
 *
 * Trap extraction is KEYWORD-BASED, deliberately, not LLM-based. Chosen for
 * determinism (same input -> same output, byte for byte), offline operation,
 * and because "how do you know that is a risk?" has a one-line answer we can
 * point at. The cost is recall, and it is disclosed rather than hidden.
 */
import { parseJson, runCommand } from "./exec.js";
import type { KnownTrap, Provenance } from "../types.js";

/** Phrases that signal unresolved work, a deferral, or a prior failure. */
export const TRAP_KEYWORDS = [
  "todo", "deferred", "defer ", "unresolved", "known risk", "open risk",
  "failed", "did not", "does not yet", "revisit", "workaround", "hack",
  "not implemented", "left out", "skipped", "assumption", "fragile",
  "deadlock", "race condition", "breaks if", "rejected", "limitation",
];

/** As emitted by `entire checkpoint list --json`. */
export type CheckpointSummary = {
  checkpoint_id?: string;
  session_id?: string;
  date?: string;
  message?: string;
  agent?: string;
  is_logs_only?: boolean;
  /** Older/alternate spellings, tolerated but not relied upon. */
  id?: string;
  sha?: string;
};

/** As emitted by `entire checkpoint explain <id> --json`. */
export type CheckpointExplain = {
  checkpoint_id?: string;
  strategy?: string;
  branch?: string;
  files_touched?: string[];
  sessions?: Array<{ files_touched?: string[] }>;
};

/** Pull whatever list shape the CLI gives us into a flat array. */
export function coerceList(data: unknown): CheckpointSummary[] {
  if (Array.isArray(data)) return data as CheckpointSummary[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["checkpoints", "items", "results", "entries"]) {
      if (Array.isArray(obj[key])) return obj[key] as CheckpointSummary[];
    }
  }
  return [];
}

/** The CLI emits `checkpoint_id`; the others are defensive fallbacks. */
export function idOf(c: CheckpointSummary): string | undefined {
  return c.checkpoint_id ?? c.id ?? c.sha;
}

/** Union of the top-level and per-session file lists, normalised. */
export function filesOf(explain: CheckpointExplain | undefined): string[] {
  const files = new Set<string>();
  for (const f of explain?.files_touched ?? []) files.add(f.split("\\").join("/"));
  for (const s of explain?.sessions ?? []) {
    for (const f of s.files_touched ?? []) files.add(f.split("\\").join("/"));
  }
  return [...files];
}

/** First line in `text` that reads like unresolved work, else undefined. */
export function findTrapLine(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*#>\s]+/, "");
    if (line.length < 16 || line.length > 300) continue;
    const lower = line.toLowerCase();
    if (TRAP_KEYWORDS.some((k) => lower.includes(k))) return line;
  }
  return undefined;
}

export type TrapEvidence = {
  traps: KnownTrap[];
  degraded: string[];
  provenance: Provenance[];
};

/**
 * Read recent checkpoints and keep those that both (a) contain a trap keyword
 * and (b) touched a file inside the blast radius. Both conditions, so we do not
 * dump the whole history at the agent as "risks".
 */
export async function knownTraps(
  cwd: string,
  radius: Set<string>,
  limit = 10,
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
  let unidentified = 0;
  let examined = 0;

  for (const entry of list.slice(0, limit)) {
    const id = idOf(entry);
    if (!id) {
      unidentified += 1;
      continue;
    }
    examined += 1;

    const explainJson = await runCommand(
      "entire",
      ["checkpoint", "explain", id, "--json"],
      { cwd },
    );
    provenance.push({
      source: "checkpoint",
      command: explainJson.command,
      confidence: "heuristic",
    });
    if (!explainJson.ok) {
      degraded.push(`checkpoint explain ${id} failed: ${explainJson.error}`);
      continue;
    }

    const files = filesOf(parseJson<CheckpointExplain>(explainJson));
    // Only surface a trap if it lands inside the radius we are guarding.
    const intersecting = files.filter((f) => radius.has(f));
    if (intersecting.length === 0) continue;

    // The commit message is the cheapest reasoning source; the --full prose is
    // the richer one. The --json form carries no text at all.
    let text = entry.message ?? "";
    const explainFull = await runCommand(
      "entire",
      ["checkpoint", "explain", id, "--full"],
      { cwd },
    );
    if (explainFull.ok) text += "\n" + explainFull.stdout;

    const line = findTrapLine(text);
    if (!line) continue;

    traps.push({
      text: line,
      checkpoint_id: id,
      files: intersecting,
      provenance: {
        source: "checkpoint",
        command: `entire checkpoint explain ${id} --full`,
        confidence: "heuristic",
      },
    });
  }

  if (unidentified > 0) {
    degraded.push(
      `${unidentified} checkpoint(s) had no recognisable identifier field and were skipped`,
    );
  }
  if (traps.length === 0) {
    degraded.push(
      `${examined} checkpoint(s) were read but none recorded unresolved work touching this blast radius (keyword extraction; unusual phrasing is missed by design)`,
    );
  }
  return { traps, degraded, provenance };
}
