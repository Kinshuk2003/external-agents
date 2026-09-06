/**
 * Contract-builder tests, pinned against REAL captured graph output.
 *
 * test/fixtures/impact.json is not hand-written: it is the verbatim result of
 * `entire graph impact` on this repository. Parsing is tested against what the
 * CLI actually emits, not against what the design hoped it would emit -- and
 * the fixture doubles as offline insurance if the CLI is unavailable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildContract, contractId } from "./build.js";
import { adjudicate } from "../adjudicate/adjudicate.js";
import { DEFAULT_POLICY, type Provenance } from "../types.js";
import type { ImpactResult } from "../evidence/graph.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, "..", "..", "test", "fixtures", "impact.json");

const impact = JSON.parse(readFileSync(fixture, "utf8")) as ImpactResult;

const PROV: Provenance = {
  source: "graph.impact",
  command:
    "entire graph impact --symbol agents/entire-agent-kiro/internal/protocol/protocol.go:107 --repo . --depth 2 --profile full --format json",
  confidence: "deterministic",
};

function build() {
  return buildContract({
    id: contractId("HandleResolveSessionFile"),
    repoRoot: "/repo",
    baseSha: "aaaaaaa",
    symbol: "HandleResolveSessionFile",
    impact,
    impactProvenance: PROV,
    policy: DEFAULT_POLICY,
    degraded: [],
  });
}

test("real graph output parses into a contract with the right focus", () => {
  const c = build();
  assert.equal(c.target.file, "agents/entire-agent-kiro/internal/protocol/protocol.go");
  assert.equal(c.target.line, 107);
  assert.equal(c.target.kind, "function");
});

test("the depth-1 caller in another file becomes an obligation", () => {
  const c = build();
  // handlers_test.go calls HandleResolveSessionFile at depth 1.
  const obliged = c.must_update.map((m) => m.path);
  assert.ok(
    obliged.includes("agents/entire-agent-kiro/internal/protocol/handlers_test.go"),
    `expected the depth-1 caller to be obliged, got ${JSON.stringify(obliged)}`,
  );
  // Every obligation must be deterministic; a heuristic relation cannot oblige.
  for (const m of c.must_update) assert.equal(m.provenance.confidence, "deterministic");
});

test("callers inside the definition file are not obligations", () => {
  const c = build();
  // Such a caller is satisfied the moment the definition file is edited, so
  // keeping it would inflate the contract with an obligation that never fires.
  assert.equal(
    c.must_update.some((m) => m.path === c.target.file),
    false,
  );
});

test("external symbols (flag.NewFlagSet) never enter the radius", () => {
  const c = build();
  assert.equal(
    c.allowed_files.some((f) => f.path.includes("NewFlagSet")),
    false,
  );
  for (const f of c.allowed_files) assert.ok(f.path.length > 0);
});

test("FILE_CHANGES_WITH co-changes are recorded as heuristic drift, never as obligations", () => {
  const c = build();
  assert.ok(c.drift_candidates.length > 0, "fixture has co_changes entries");
  for (const d of c.drift_candidates) assert.equal(d.provenance.confidence, "heuristic");
  // A drift candidate must never appear as a must_update.
  const obliged = new Set(c.must_update.map((m) => m.path));
  for (const d of c.drift_candidates) assert.equal(obliged.has(d.path), false);
});

test("graph warnings and partial failures are surfaced, not swallowed", () => {
  // The fixture carries W_WORKTREE_SNAPSHOT and an E_MINIFIED partial failure.
  assert.ok((impact.warnings ?? []).length > 0);
  assert.ok((impact.partial_failures ?? []).length > 0);
});

test("end to end on real evidence: editing only the definition FAILS on the forgotten caller", () => {
  const c = build();
  const verdict = adjudicate(
    c,
    {
      changed_files: ["agents/entire-agent-kiro/internal/protocol/protocol.go"],
      semantic_changes: null,
      head_sha: "bbbbbbb",
      degraded: [],
      provenance: [],
    },
    { ...DEFAULT_POLICY, always_allowed: [] },
  );
  assert.equal(verdict.status, "FAIL");
  assert.deepEqual(
    verdict.forgotten.map((f) => f.path),
    ["agents/entire-agent-kiro/internal/protocol/handlers_test.go"],
  );
});
