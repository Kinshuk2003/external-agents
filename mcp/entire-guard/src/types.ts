/**
 * entire-guard shared types.
 *
 * Every finding carries the literal command that produced it, so a judge (or a
 * reviewer) can copy it out of our output and re-run it. Provenance is not
 * decoration: it is how we obey "show where the evidence came from".
 */

/** How much we trust a finding. Heuristic findings must never alone drive a FAIL. */
export type Confidence = "deterministic" | "heuristic";

export type Provenance = {
  source: "graph.impact" | "graph.diff" | "checkpoint" | "git" | "why";
  /** The exact command run, verbatim, for independent verification. */
  command: string;
  confidence: Confidence;
};

export type AllowedFile = {
  path: string;
  reason: string;
  provenance: Provenance;
};

/** A direct caller the change is obliged to update. Deterministic (CALLS) only. */
export type MustUpdate = {
  path: string;
  symbol: string;
  relation: string;
  provenance: Provenance;
};

/**
 * A file that historically changes together with the target but that the graph
 * cannot prove is coupled. This is how cross-module drift surfaces (e.g. seven
 * copy-pasted protocol.go files in separate Go modules that no compiler links).
 * Heuristic by construction: WARN, never FAIL.
 */
export type DriftCandidate = {
  path: string;
  detail: string;
  provenance: Provenance;
};

/** Unresolved work or a prior failure recalled from checkpoint history. */
export type KnownTrap = {
  text: string;
  checkpoint_id: string;
  /** Files the checkpoint touched, used to decide whether the trap was hit. */
  files: string[];
  provenance: Provenance;
};

export type ChangeContract = {
  id: string;
  created_at: string;
  repo_root: string;
  base_sha: string;
  target: { symbol: string; file?: string; line?: number; kind?: string };
  allowed_files: AllowedFile[];
  must_update: MustUpdate[];
  drift_candidates: DriftCandidate[];
  known_traps: KnownTrap[];
  /** What we could NOT determine, and why. Never silently empty. */
  degraded: string[];
  policy: Policy;
};

/** Everything the working tree actually did, gathered at verify time. */
export type ActualChanges = {
  changed_files: string[];
  semantic_changes: unknown;
  head_sha: string;
  degraded: string[];
  provenance: Provenance[];
};

export type Verdict = {
  status: "PASS" | "WARN" | "FAIL";
  /** Edited but outside the proven blast radius. Deterministic -> FAIL. */
  out_of_bounds: Array<{ path: string; note: string; provenance: Provenance }>;
  /** A direct caller that was obliged to change and did not. The headline finding. */
  forgotten: Array<{ path: string; symbol: string; relation: string; provenance: Provenance }>;
  /** Historically co-changing files left untouched. Heuristic -> WARN. */
  drift_candidates: Array<{ path: string; detail: string; provenance: Provenance }>;
  /** A known unresolved risk in territory this change touched. Heuristic -> WARN. */
  traps_hit: Array<{ text: string; checkpoint_id: string; path: string; provenance: Provenance }>;
  in_bounds: string[];
  semantic_changes: unknown;
  degraded: string[];
  contract_id: string;
  base_sha: string;
  head_sha: string;
};

/**
 * Policy lives in exactly one object, from the first commit, so that a new
 * constraint is a config change rather than a rewrite. Do not scatter these
 * thresholds through the code.
 */
export type Policy = {
  depth: 1 | 2;
  exclude_tests: boolean;
  /** Silent-truncation budget on graph impact. The 4096 default clips radius. */
  max_context_bytes: number;
  /** Which deterministic findings escalate to FAIL. */
  fail_on: Array<"out_of_bounds" | "forgotten">;
  /** Paths always permitted to change (docs, the contract store itself). */
  always_allowed: string[];
  /** Fail closed when evidence is degraded rather than reporting a soft PASS. */
  fail_on_degraded: boolean;
};

export const DEFAULT_POLICY: Policy = {
  depth: 2,
  exclude_tests: false,
  max_context_bytes: 65536,
  fail_on: ["out_of_bounds", "forgotten"],
  always_allowed: [".entire-guard/", "BUILDATHON.md", "evidence/"],
  fail_on_degraded: false,
};
