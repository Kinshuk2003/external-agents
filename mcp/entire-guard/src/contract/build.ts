/**
 * Contract builder: turn graph + checkpoint evidence into a ChangeContract.
 *
 * The distinction that matters:
 *   must_update      = DIRECT (depth-1) callers, relation CALLS. Deterministic.
 *   allowed_files    = the whole reachable radius. Deterministic.
 *   drift_candidates = FILE_CHANGES_WITH co-changes. HEURISTIC -> WARN only.
 */
import type {
  AllowedFile,
  ChangeContract,
  DriftCandidate,
  MustUpdate,
  Policy,
  Provenance,
} from "../types.js";
import { confidenceFor, type GraphBucket, type ImpactResult } from "../evidence/graph.js";

function norm(p: string): string {
  return p.split("\\").join("/").replace(/^\.\//, "");
}

/**
 * Repository plumbing: CI workflows, lint config, ignore files, licence and
 * lockfiles. These co-change with almost every commit, so a FILE_CHANGES_WITH
 * edge to one of them carries no information about THIS symbol. Excluding them
 * is presentation, not judgement -- they stay inside `allowed_files`, so
 * editing one is never penalised; they are only kept out of the drift warning
 * list, where noise buries the row that matters.
 */
export function isRepoPlumbing(path: string): boolean {
  if (path.startsWith(".github/")) return true;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (!path.includes("/") && base.startsWith(".")) return true; // root dotfiles
  return /^(LICENSE|NOTICE|CHANGELOG|CODEOWNERS)/i.test(base) ||
    /^(mise\.toml|Makefile|Dockerfile|.*\.ya?ml|.*lock(file)?(\.json|\.yaml)?|package-lock\.json|go\.sum)$/i.test(base);
}

/** "files changed together in 4 recent commits" -> 4. Unparseable -> 0. */
export function coChangeStrength(detail: string | undefined): number {
  const m = /(\d+)\s+recent commits?/.exec(detail ?? "");
  return m ? Number(m[1]) : 0;
}

function addFrom(
  bucket: GraphBucket | undefined,
  reason: string,
  provenance: Provenance,
  into: Map<string, AllowedFile>,
): void {
  for (const edge of bucket?.entries ?? []) {
    const path = edge.endpoint.file_path;
    if (!path || edge.endpoint.external) continue; // external symbols have no file here
    const key = norm(path);
    if (into.has(key)) continue;
    into.set(key, {
      path: key,
      reason: `${reason} (${edge.relation}, depth ${edge.depth ?? 1})`,
      provenance: { ...provenance, confidence: confidenceFor(edge.relation) },
    });
  }
}

export function buildContract(args: {
  id: string;
  repoRoot: string;
  baseSha: string;
  symbol: string;
  impact: ImpactResult | undefined;
  impactProvenance: Provenance;
  policy: Policy;
  degraded: string[];
}): ChangeContract {
  const { impact, impactProvenance, policy } = args;

  const allowedMap = new Map<string, AllowedFile>();
  const must_update: MustUpdate[] = [];
  const drift_candidates: DriftCandidate[] = [];
  /** Every co-change seen, before ranking and capping. */
  const candidateDrift: DriftCandidate[] = [];
  /** What the drift filter hid, so it can be disclosed rather than swallowed. */
  const degradedFromDrift: string[] = [];

  const focusFile = impact?.focus?.file_path ? norm(impact.focus.file_path) : undefined;
  if (focusFile) {
    allowedMap.set(focusFile, {
      path: focusFile,
      reason: "definition site of the target symbol",
      provenance: impactProvenance,
    });
  }

  addFrom(impact?.callers, "calls the target", impactProvenance, allowedMap);
  addFrom(impact?.callees, "called by the target", impactProvenance, allowedMap);
  addFrom(impact?.type_consumers, "consumes the target type", impactProvenance, allowedMap);
  addFrom(impact?.data_flows, "data flows through the target", impactProvenance, allowedMap);
  addFrom(impact?.siblings, "sibling of the target", impactProvenance, allowedMap);

  // Obliged callers: depth-1, inbound, deterministic relation only. A heuristic
  // relation must never create an obligation that can fail a change.
  //
  // Two deliberate narrowings, both so that a FAIL means something:
  //  - callers inside the definition file are dropped. Adjudication is
  //    path-level, so such a caller is satisfied the instant the definition is
  //    edited; keeping it would inflate the contract without ever firing.
  //  - callers are grouped per file. One obligation per file, listing every
  //    calling symbol, because "you forgot this file" is the actionable claim.
  const callerSymbolsByPath = new Map<string, { symbols: string[]; relation: string }>();
  for (const edge of impact?.callers?.entries ?? []) {
    const path = edge.endpoint.file_path;
    if (!path || edge.endpoint.external) continue;
    if ((edge.depth ?? 1) !== 1) continue;
    if (confidenceFor(edge.relation) !== "deterministic") continue;
    const key = norm(path);
    if (key === focusFile) continue;
    const name = edge.endpoint.qualified_name ?? edge.endpoint.name;
    const existing = callerSymbolsByPath.get(key);
    if (existing) {
      if (!existing.symbols.includes(name)) existing.symbols.push(name);
    } else {
      callerSymbolsByPath.set(key, { symbols: [name], relation: edge.relation });
    }
  }
  for (const [path, { symbols, relation }] of callerSymbolsByPath) {
    must_update.push({
      path,
      symbol: symbols.join(", "),
      relation,
      provenance: impactProvenance,
    });
  }

  // Co-change history: files that move together but that nothing structurally
  // links. This is the cross-module drift signal -- the case where seven
  // copy-pasted files live in separate modules and no compiler relates them.
  //
  // A file that is already a deterministic obligation is NOT also reported as
  // heuristic drift: the stronger claim subsumes the weaker one, and reporting
  // both would show the same file twice in a verdict under two confidences.
  const obligedPaths = new Set(must_update.map((m) => m.path));
  for (const edge of impact?.co_changes?.entries ?? []) {
    const path = edge.endpoint.file_path;
    if (!path) continue;
    const key = norm(path);
    if (key === focusFile || obligedPaths.has(key)) {
      if (!allowedMap.has(key)) {
        allowedMap.set(key, {
          path: key,
          reason: `historically changes with the target (${edge.relation}, heuristic)`,
          provenance: { ...impactProvenance, confidence: "heuristic" },
        });
      }
      continue;
    }
    candidateDrift.push({
      path: key,
      detail: edge.detail ?? edge.relation,
      provenance: { ...impactProvenance, confidence: "heuristic" },
    });
    if (!allowedMap.has(key)) {
      allowedMap.set(key, {
        path: key,
        reason: `historically changes with the target (${edge.relation}, heuristic)`,
        provenance: { ...impactProvenance, confidence: "heuristic" },
      });
    }
  }

  // Rank, filter and cap the drift list. Every co-change stays in
  // `allowed_files` -- editing one is never penalised. This only decides what
  // is worth SHOWING, because a 13-row warning list buries its own signal.
  const plumbing = candidateDrift.filter((d) => isRepoPlumbing(d.path));
  const ranked = candidateDrift
    .filter((d) => !isRepoPlumbing(d.path))
    .sort((a, b) => coChangeStrength(b.detail) - coChangeStrength(a.detail));
  const weak = ranked.filter((d) => coChangeStrength(d.detail) < policy.drift_min_commits);
  const strong = ranked.filter((d) => coChangeStrength(d.detail) >= policy.drift_min_commits);
  drift_candidates.push(...strong.slice(0, policy.drift_max));

  // Say what was hidden and why. Suppressing evidence silently would be the
  // same class of failure this product exists to catch.
  const hiddenCap = Math.max(0, strong.length - policy.drift_max);
  if (plumbing.length > 0) {
    degradedFromDrift.push(
      `${plumbing.length} co-changing file(s) omitted from drift warnings as repository plumbing (CI, lint, ignore, lockfiles); they remain permitted to edit`,
    );
  }
  if (weak.length > 0) {
    degradedFromDrift.push(
      `${weak.length} co-changing file(s) omitted as weaker than ${policy.drift_min_commits} shared commits`,
    );
  }
  if (hiddenCap > 0) {
    degradedFromDrift.push(
      `${hiddenCap} further co-changing file(s) omitted beyond the drift_max cap of ${policy.drift_max}`,
    );
  }

  const degraded = [...args.degraded, ...degradedFromDrift];
  if (!impact) {
    degraded.push("no impact result: the blast radius is UNKNOWN, not empty");
  } else if ((impact.callers?.total ?? 0) === 0) {
    degraded.push(
      "graph reports zero callers -- either the symbol is genuinely unused, or it is reached by dynamic dispatch, reflection or codegen, which a static graph cannot see",
    );
  }

  return {
    id: args.id,
    created_at: new Date().toISOString(),
    repo_root: args.repoRoot,
    base_sha: args.baseSha,
    target: {
      symbol: args.symbol,
      file: focusFile,
      line: impact?.focus?.start_line,
      kind: impact?.focus?.kind,
    },
    allowed_files: [...allowedMap.values()].sort((a, b) => a.path.localeCompare(b.path)),
    must_update,
    drift_candidates,
    known_traps: [],
    degraded,
    policy,
  };
}

export function contractId(symbol: string): string {
  const slug = symbol.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-24) || "target";
  return `ct-${Date.now()}-${slug}`;
}
