/**
 * The shared normalisation layer.
 *
 * The Track 3 card forbids duplicating the implementation per format. This file
 * is how that rule is kept: claim de-duplication, unknown-event counting and
 * lifecycle accumulation live here exactly once, and a format reader is reduced
 * to deciding *which* accumulator call each record maps to.
 *
 * The two formats report changes in structurally different ways -- one hands
 * over a set of files at the end, the other streams an event per edit. The
 * accumulator absorbs that difference, which is why a shared schema would not
 * have worked but a shared accumulator does.
 */
import type { ClaimedChange, SessionCheckpoint, UnknownEvent } from "../../types.js";

export type Accumulator = {
  session_id?: string;
  agent?: string;
  repo?: string;
  /** Keyed by normalised path, so a stream format and a batch format converge. */
  claims: Map<string, ClaimedChange>;
  lifecycle: { started: boolean; ended: boolean; status?: string };
  checkpoints: SessionCheckpoint[];
  unknown: Map<string, UnknownEvent>;
};

export function newAccumulator(): Accumulator {
  return {
    claims: new Map(),
    lifecycle: { started: false, ended: false },
    checkpoints: [],
    unknown: new Map(),
  };
}

/** Forward slashes, no leading "./" -- the same rule the adjudicator applies. */
export function normaliseClaimPath(p: string): string {
  return p.split("\\").join("/").replace(/^\.\//, "").trim();
}

/**
 * Record one claimed change.
 *
 * De-duplicated by path. `kind` is the *last* reported state, because that is
 * the one that can be reconciled against a diff: a file created and then
 * modified is, on disk, created. `line` stays the first sighting so a reader
 * can find where the claim entered the transcript, and `events` counts the
 * mentions, which is the only place the stream-versus-batch distinction
 * survives normalisation.
 */
export function addClaim(
  acc: Accumulator,
  rawPath: string,
  kind: ClaimedChange["kind"],
  line: number,
  summary?: string,
): void {
  const path = normaliseClaimPath(rawPath);
  if (!path) return;

  const existing = acc.claims.get(path);
  if (!existing) {
    acc.claims.set(path, { path, kind, line, events: 1, ...(summary ? { summary } : {}) });
    return;
  }

  existing.kind = kind;
  existing.events += 1;
  if (!existing.summary && summary) existing.summary = summary;
}

/**
 * Record an event kind we do not understand.
 *
 * Counted, never thrown, and never a reason to discard the session. It is still
 * disclosed, because an unread event may have carried a file change -- which is
 * a gap in what we know, not a licence to assume nothing happened.
 */
export function noteUnknown(acc: Accumulator, name: string, line: number): void {
  const existing = acc.unknown.get(name);
  if (existing) {
    existing.count += 1;
    return;
  }
  acc.unknown.set(name, { name, count: 1, first_line: line });
}

/** First non-empty value wins, so the earliest record establishes identity. */
export function noteIdentity(
  acc: Accumulator,
  field: "session_id" | "agent" | "repo",
  value: unknown,
): void {
  if (typeof value !== "string" || value.trim() === "") return;
  if (acc[field]) return;
  acc[field] = value.trim();
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}
