/**
 * Drift-list ranking tests.
 *
 * Co-change is a RANKED signal, not a set. A file that changes alongside every
 * commit (CI config, lint config, ignore files) carries no information about
 * the symbol under change, and a long warning list buries the row that matters.
 *
 * The filter is presentation only: everything stays in `allowed_files`, so
 * editing a suppressed file is never penalised, and everything suppressed is
 * disclosed in `degraded[]`. Hiding evidence silently would be the same class
 * of failure this product exists to catch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildContract, coChangeStrength, isRepoPlumbing } from "./build.js";
import { DEFAULT_POLICY, type Provenance } from "../types.js";
import type { GraphEdge, ImpactResult } from "../evidence/graph.js";

const PROV: Provenance = {
  source: "graph.impact",
  command: "entire graph impact --symbol Target --repo . --depth 2 --profile full --format json",
  confidence: "deterministic",
};

function coChange(path: string, commits: number): GraphEdge {
  return {
    endpoint: { id: `local:file:${path}`, name: path, kind: "file", file_path: path },
    relation: "FILE_CHANGES_WITH",
    detail: `files changed together in ${commits} recent commits`,
  };
}

function impactWith(entries: GraphEdge[]): ImpactResult {
  return {
    format_version: 1,
    repo_root: "/repo",
    commit: "aaa",
    profile: "full",
    query: "Target",
    depth: 2,
    focus_matches_total: 1,
    focus: {
      id: "local:Go:src/target.go:function:Target",
      name: "Target",
      kind: "function",
      file_path: "src/target.go",
      start_line: 10,
      language: "Go",
    },
    co_changes: { total: entries.length, entries },
  };
}

function build(entries: GraphEdge[], policy = DEFAULT_POLICY) {
  return buildContract({
    id: "ct-drift",
    repoRoot: "/repo",
    baseSha: "aaa",
    symbol: "Target",
    impact: impactWith(entries),
    impactProvenance: PROV,
    policy,
    degraded: [],
  });
}

test("repo plumbing is recognised, real source is not", () => {
  for (const p of [
    ".github/workflows/ci.yml",
    ".github/workflows/lint.yml",
    ".gitignore",
    ".golangci.yaml",
    "mise.toml",
    "LICENSE",
    "package-lock.json",
  ]) {
    assert.equal(isRepoPlumbing(p), true, `${p} should be plumbing`);
  }
  for (const p of [
    "agents/entire-agent-kiro/internal/protocol/protocol.go",
    "src/target.go",
    "internal/kiro/agent.go",
  ]) {
    assert.equal(isRepoPlumbing(p), false, `${p} should NOT be plumbing`);
  }
});

test("co-change strength parses the commit count, and degrades to 0", () => {
  assert.equal(coChangeStrength("files changed together in 4 recent commits"), 4);
  assert.equal(coChangeStrength("files changed together in 1 recent commit"), 1);
  assert.equal(coChangeStrength(undefined), 0);
  assert.equal(coChangeStrength("FILE_CHANGES_WITH"), 0);
});

test("plumbing is excluded from drift warnings but stays editable", () => {
  const c = build([
    coChange(".github/workflows/ci.yml", 9),
    coChange(".gitignore", 9),
    coChange("internal/kiro/agent.go", 5),
  ]);
  assert.deepEqual(c.drift_candidates.map((d) => d.path), ["internal/kiro/agent.go"]);
  // Critically: still permitted to edit, so no FAIL for touching them.
  const allowed = c.allowed_files.map((f) => f.path);
  assert.ok(allowed.includes(".github/workflows/ci.yml"));
  assert.ok(allowed.includes(".gitignore"));
  // And the suppression is disclosed, not silent.
  assert.ok(c.degraded.some((d) => /repository plumbing/.test(d)));
});

test("drift is ranked strongest-first and capped, with the remainder disclosed", () => {
  const c = build(
    [
      coChange("a.go", 2),
      coChange("b.go", 9),
      coChange("c.go", 5),
      coChange("d.go", 7),
    ],
    { ...DEFAULT_POLICY, drift_max: 2 },
  );
  assert.deepEqual(c.drift_candidates.map((d) => d.path), ["b.go", "d.go"]);
  assert.ok(
    c.degraded.some((d) => /2 further co-changing file\(s\) omitted beyond the drift_max cap of 2/.test(d)),
    `expected cap disclosure, got ${JSON.stringify(c.degraded)}`,
  );
});

test("co-changes weaker than drift_min_commits are dropped and disclosed", () => {
  const c = build(
    [coChange("weak.go", 1), coChange("strong.go", 6)],
    { ...DEFAULT_POLICY, drift_min_commits: 2 },
  );
  assert.deepEqual(c.drift_candidates.map((d) => d.path), ["strong.go"]);
  assert.ok(c.degraded.some((d) => /weaker than 2 shared commits/.test(d)));
});

test("suppression never removes a deterministic obligation", () => {
  // A path can be plumbing AND a proven caller. The obligation must survive.
  const impact = impactWith([coChange(".github/workflows/ci.yml", 9)]);
  impact.callers = {
    total: 1,
    direct: 1,
    entries: [
      {
        endpoint: {
          id: "local:Go:internal/kiro/agent.go:function:Caller",
          name: "Caller",
          kind: "function",
          file_path: "internal/kiro/agent.go",
        },
        relation: "CALLS",
        direction: "in",
        depth: 1,
      },
    ],
  };
  const c = buildContract({
    id: "ct-x",
    repoRoot: "/repo",
    baseSha: "aaa",
    symbol: "Target",
    impact,
    impactProvenance: PROV,
    policy: DEFAULT_POLICY,
    degraded: [],
  });
  assert.deepEqual(c.must_update.map((m) => m.path), ["internal/kiro/agent.go"]);
});
