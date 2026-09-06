/**
 * Entire Graph adapter.
 *
 * Field names here are pinned against real captured output in
 * test/fixtures/impact.json -- not against what the design hoped for.
 *
 * Two facts from `entire graph capabilities --json` shape this file:
 *  - the `full` profile is required for DATA_FLOWS / TESTS / FILE_CHANGES_WITH;
 *  - --max-context-bytes (default 4096) SILENTLY truncates the radius, which
 *    would corrupt the exact claim the product rests on. We raise it and
 *    detect truncation rather than trusting the default.
 */
import { parseJson, runCommand, type CommandResult } from "./exec.js";
import type { Policy, Provenance } from "../types.js";

export type GraphEndpoint = {
  id: string;
  name: string;
  qualified_name?: string;
  kind?: string;
  file_path?: string;
  start_line?: number;
  end_line?: number;
  language?: string;
  external?: boolean;
};

export type GraphEdge = {
  endpoint: GraphEndpoint;
  relation: string;
  direction?: string;
  depth?: number;
  detail?: string;
  call_site?: { file_path: string; line: number };
};

export type GraphBucket = { total: number; direct?: number; entries: GraphEdge[] };

export type ImpactResult = {
  format_version: number;
  repo_root: string;
  commit: string;
  profile: string;
  query: string;
  file?: string;
  line?: number;
  depth: number;
  focus_matches_total: number;
  disambiguation_required?: boolean;
  focus?: GraphEndpoint;
  focus_candidates?: GraphEndpoint[];
  callers?: GraphBucket;
  callees?: GraphBucket;
  type_consumers?: GraphBucket;
  data_flows?: GraphBucket;
  co_changes?: GraphBucket;
  siblings?: GraphBucket;
  warnings?: Array<{ code: string; severity: string; effect_on_semantic_completeness?: string }>;
  partial_failures?: Array<{ code: string; severity: string; file_path?: string; detail?: string }>;
  completeness?: unknown;
  stats?: unknown;
};

export type ImpactEvidence = {
  data?: ImpactResult;
  provenance: Provenance;
  raw: CommandResult;
  degraded: string[];
};

/** Relations the graph reports but cannot prove. Never allowed to drive a FAIL. */
export const HEURISTIC_RELATIONS = new Set(["FILE_CHANGES_WITH", "TESTS"]);

export function confidenceFor(relation: string): Provenance["confidence"] {
  return HEURISTIC_RELATIONS.has(relation) ? "heuristic" : "deterministic";
}

/**
 * `symbol` may be a bare name or a `<file>:<line>` selector. The selector form
 * is the escape hatch for ambiguity; we never guess between definitions.
 */
export async function impact(
  cwd: string,
  symbol: string,
  policy: Policy,
  useHead: boolean,
): Promise<ImpactEvidence> {
  const args = [
    "graph",
    "impact",
    "--symbol",
    symbol,
    "--repo",
    ".",
    "--depth",
    String(policy.depth),
    "--profile",
    "full",
    "--format",
    "json",
    "--max-context-bytes",
    String(policy.max_context_bytes),
  ];
  if (policy.exclude_tests) args.push("--exclude-tests");
  if (useHead) args.push("--head");

  const raw = await runCommand("entire", args, { cwd });
  const provenance: Provenance = {
    source: "graph.impact",
    command: raw.command,
    confidence: "deterministic",
  };
  const degraded: string[] = [];

  if (!raw.ok) {
    const hint = /unknown command|plugin/i.test(raw.error ?? "")
      ? " -- the graph plugin may not be installed: run `entire plugin install graph`"
      : "";
    degraded.push(`graph impact failed: ${raw.error}${hint}`);
    return { provenance, raw, degraded };
  }

  const data = parseJson<ImpactResult>(raw);
  if (!data) {
    degraded.push("graph impact returned output that is not JSON; radius not established");
    return { provenance, raw, degraded };
  }

  for (const w of data.warnings ?? []) {
    degraded.push(`graph warning ${w.code}: ${w.effect_on_semantic_completeness ?? w.severity}`);
  }
  for (const f of data.partial_failures ?? []) {
    degraded.push(`graph partial failure ${f.code} on ${f.file_path ?? "?"}: ${f.detail ?? ""}`.trim());
  }
  if (data.profile !== "full") {
    degraded.push(
      `graph ran with profile "${data.profile}", not "full": DATA_FLOWS, TESTS and FILE_CHANGES_WITH are unavailable, so the radius is narrower than reality`,
    );
  }
  // Silent truncation detector: if the response filled the budget, the radius
  // may have been clipped with no error, and we must say so.
  if (raw.stdout.length >= policy.max_context_bytes) {
    degraded.push(
      `graph impact output reached the --max-context-bytes budget (${policy.max_context_bytes}); the blast radius may be truncated`,
    );
  }
  const lang = data.focus?.language;
  if (lang && !SEMANTIC_LANGUAGES.has(lang)) {
    degraded.push(
      `${lang} is not a deep-relation language for this graph: only CONTAINS/DEFINES are available, so callers may be missing`,
    );
  }

  return { data, provenance, raw, degraded };
}

/** Languages with deep (semantic) relation support. Others degrade loudly. */
export const SEMANTIC_LANGUAGES = new Set([
  "TypeScript", "JavaScript", "TSX", "JSX", "Python", "Go", "Java", "Rust",
  "C#", "Ruby", "PHP", "Kotlin", "Swift", "Scala", "C", "C++",
]);

export type DiffEvidence = {
  data?: unknown;
  provenance: Provenance;
  raw: CommandResult;
  degraded: string[];
};

/** Entity-level semantic diff -- what changed in meaning, not in text. */
export async function semanticDiff(
  cwd: string,
  base: string,
  head: string,
): Promise<DiffEvidence> {
  const raw = await runCommand(
    "entire",
    ["graph", "diff", "--base", base, "--head", head, "--json"],
    { cwd },
  );
  const provenance: Provenance = {
    source: "graph.diff",
    command: raw.command,
    confidence: "deterministic",
  };
  const degraded: string[] = [];
  if (!raw.ok) {
    degraded.push(`graph diff failed: ${raw.error}`);
    return { provenance, raw, degraded };
  }
  const data = parseJson<{ warnings?: Array<{ code: string; detail?: string }> }>(raw);
  if (!data) {
    degraded.push("graph diff returned output that is not JSON; semantic change set unavailable");
    return { provenance, raw, degraded };
  }
  for (const w of data.warnings ?? []) {
    degraded.push(`graph diff warning ${w.code}: ${w.detail ?? ""}`.trim());
  }
  return { data, provenance, raw, degraded };
}
