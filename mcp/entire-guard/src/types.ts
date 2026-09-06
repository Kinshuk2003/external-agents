/**
 * entire-guard shared types.
 *
 * Every finding carries the literal command that produced it, so a judge (or a
 * reviewer) can copy it out of our output and re-run it. Provenance is not
 * decoration: it is how we obey "show where the evidence came from".
 */

/**
 * How much we trust a finding.
 *
 * "deterministic" -- proved by set arithmetic over git or a non-heuristic graph relation.
 * "heuristic"     -- a graph hint (TESTS, FILE_CHANGES_WITH) or a keyword-matched trap.
 * "claimed"       -- the agent said so in its own transcript. Self-reported, and therefore
 *                    weaker than either of the above: a claim may be false, and a truncated
 *                    transcript simply contains fewer of them.
 *
 * Neither "heuristic" nor "claimed" may alone drive a FAIL.
 */
export type Confidence = "deterministic" | "heuristic" | "claimed";

export type Provenance = {
  source: "graph.impact" | "graph.diff" | "checkpoint" | "git" | "why" | "transcript";
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

/**
 * Everything gathered at verify time.
 *
 * `changed_files` is deterministic: it is what git says is on disk. `session` is
 * optional and *claimed*: it is what the agent says it did. The two are kept in
 * separate fields on purpose -- merging them would erase the difference in
 * confidence, which is the whole point of reading a transcript at all.
 */
export type ActualChanges = {
  changed_files: string[];
  semantic_changes: unknown;
  head_sha: string;
  degraded: string[];
  provenance: Provenance[];
  /** The agent's own account of what it did, when one was supplied. */
  session?: AgentSession;
  /** True when git evidence for the change set could not be obtained. */
  git_unavailable?: boolean;
};

/**
 * What the verdict is built on.
 *
 * "claimed_only" can never be PASS. The restriction lives here, in the type, so
 * that incomplete context cannot be presented as an authoritative result by a
 * caller who simply forgot to check.
 */
export type EvidenceBasis = "deterministic" | "reconciled" | "claimed_only";

export type Verdict = {
  status: "PASS" | "WARN" | "FAIL";
  /** Which sources the verdict rests on. */
  evidence_basis: EvidenceBasis;
  /**
   * The agent's own transcript reports editing a file the contract forbids.
   * An admission against interest, checked against a deterministic radius, so
   * the breach stands regardless of how reliable the transcript is. -> FAIL.
   */
  out_of_bounds_by_claim: Array<{ path: string; note: string; provenance: Provenance }>;
  /** Claimed in the transcript, absent from the diff. Claimed -> WARN. */
  unverified_claims: Array<{ path: string; note: string; provenance: Provenance }>;
  /** Present in the diff, never mentioned in the transcript. Claimed -> WARN. */
  unclaimed_changes: Array<{ path: string; note: string; provenance: Provenance }>;
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
  /** Which findings escalate to FAIL. Every member is deterministic by design. */
  fail_on: Array<"out_of_bounds" | "forgotten" | "out_of_bounds_by_claim">;
  /**
   * Cap on reported drift candidates. Co-change is a ranked signal, not a set:
   * a file that changes alongside everything carries no information, and a long
   * list buries the one row that matters.
   */
  drift_max: number;
  /** Ignore co-change relationships weaker than this many shared commits. */
  drift_min_commits: number;
  /** Paths always permitted to change (docs, the contract store itself). */
  always_allowed: string[];
  /** Fail closed when evidence is degraded rather than reporting a soft PASS. */
  fail_on_degraded: boolean;
};

export const DEFAULT_POLICY: Policy = {
  depth: 2,
  exclude_tests: false,
  max_context_bytes: 65536,
  fail_on: ["out_of_bounds", "forgotten", "out_of_bounds_by_claim"],
  drift_max: 5,
  drift_min_commits: 2,
  always_allowed: [".entire-guard/", "BUILDATHON.md", "evidence/"],
  fail_on_degraded: false,
};

/* ------------------------------------------------------------------------- *
 * Agent session transcripts
 *
 * Added for the Noon Curveball. The agent's own transcript is a second record
 * of what changed -- and unlike a diff, it arrives in a format that can change
 * underneath us. These types are what every format normalises into, so that
 * exactly one adjudicator serves all of them.
 * ------------------------------------------------------------------------- */

/**
 * A transcript format we can read.
 *
 * "entire-protocol" -- this repository's external-agent protocol: numeric
 *   `EventJSON.type`, `HookInputJSON.hook_type`, `AgentSessionJSON` file lists.
 * "acme-events" -- the format introduced by the Curveball: a string-tagged
 *   event envelope with per-edit `file_changed` records.
 */
export type SessionFormat = "entire-protocol" | "acme-events";

/**
 * One file the agent says it changed.
 *
 * This is a claim, not an observation. `kind` is the final state reported for
 * the path; `events` counts how many times the transcript mentioned it, which
 * is how a stream format and a batch format stay distinguishable after
 * normalisation.
 */
export type ClaimedChange = {
  path: string;
  kind: "modified" | "created" | "deleted";
  summary?: string;
  /** 1-based line in the transcript where the path was first reported. */
  line: number;
  events: number;
};

/** A checkpoint the transcript says was created, with any unresolved questions. */
export type SessionCheckpoint = {
  checkpoint_id: string;
  git_commit?: string;
  intent?: string;
  summary?: string;
  open_questions: string[];
  /** 1-based line in the transcript. */
  line: number;
};

/**
 * An event kind this integration does not understand.
 *
 * Recorded rather than thrown: a format is allowed to grow events we have never
 * seen, and an unknown event is not a reason to discard a session. It *is* a
 * reason to say so, because an unread event may have carried a file change.
 */
export type UnknownEvent = { name: string; count: number; first_line: number };

/** The normalised form every transcript format is read into. */
export type AgentSession = {
  format: SessionFormat;
  /** Where this came from, for provenance. */
  source: string;
  session_id?: string;
  agent?: string;
  repo?: string;
  claimed_changes: ClaimedChange[];
  lifecycle: { started: boolean; ended: boolean; status?: string };
  checkpoints: SessionCheckpoint[];
  unknown_events: UnknownEvent[];
  records_parsed: number;
  /**
   * True only when the transcript ended cleanly *and* every line parsed.
   * A false value makes PASS unreachable -- see EvidenceBasis.
   */
  complete: boolean;
  degraded: string[];
  provenance: Provenance;
};

/**
 * The result of reading a transcript.
 *
 * `session` is absent when the format could not be established. That is a
 * refusal, not an empty session: guessing a format would silently produce zero
 * claims, which is exactly the "confident but wrong" failure this codebase
 * treats as the worst outcome.
 */
export type SessionEvidence = {
  session?: AgentSession;
  degraded: string[];
  provenance: Provenance;
};
