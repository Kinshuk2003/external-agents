/**
 * Adjudicator unit tests.
 *
 * Fixture in, verdict out. No CLI, no network, no filesystem -- milliseconds.
 * These five cases are the behaviours the product actually claims.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { adjudicate, normalisePath } from "./adjudicate.js";
import { DEFAULT_POLICY, type ActualChanges, type ChangeContract, type Provenance } from "../types.js";

const DET: Provenance = {
  source: "graph.impact",
  command: "entire graph impact --symbol WriteJSON --repo . --depth 2 --profile full --format json",
  confidence: "deterministic",
};
const HEUR: Provenance = {
  source: "graph.impact",
  command: "entire graph impact --symbol WriteJSON --repo . --depth 2 --profile full --format json",
  confidence: "heuristic",
};
const CKPT: Provenance = {
  source: "checkpoint",
  command: "entire checkpoint explain ckpt-1 --json",
  confidence: "heuristic",
};

/** A contract with one obliged caller, one heuristic co-change, one trap. */
function contract(overrides: Partial<ChangeContract> = {}): ChangeContract {
  return {
    id: "ct-test",
    created_at: "2026-09-06T00:00:00.000Z",
    repo_root: "/repo",
    base_sha: "aaaaaaa",
    target: { symbol: "WriteJSON", file: "agents/entire-agent-kiro/internal/protocol/protocol.go" },
    allowed_files: [
      { path: "agents/entire-agent-kiro/internal/protocol/protocol.go", reason: "definition site", provenance: DET },
      { path: "agents/entire-agent-kiro/internal/protocol/handlers_test.go", reason: "caller", provenance: DET },
    ],
    must_update: [
      {
        path: "agents/entire-agent-kiro/internal/protocol/handlers_test.go",
        symbol: "TestHandlerRoundTripForCoreProtocolCommands",
        relation: "CALLS",
        provenance: DET,
      },
    ],
    drift_candidates: [
      { path: "agents/entire-agent-amp/internal/protocol/protocol.go", detail: "files changed together in 2 recent commits", provenance: HEUR },
    ],
    known_traps: [
      {
        text: "rate limiting deliberately deferred",
        checkpoint_id: "ckpt-1",
        files: ["agents/entire-agent-kiro/internal/protocol/protocol.go"],
        provenance: CKPT,
      },
    ],
    degraded: [],
    policy: DEFAULT_POLICY,
    ...overrides,
  };
}

function actual(changed: string[], overrides: Partial<ActualChanges> = {}): ActualChanges {
  return {
    changed_files: changed,
    semantic_changes: null,
    head_sha: "bbbbbbb",
    degraded: [],
    provenance: [],
    ...overrides,
  };
}

test("forgotten caller -> FAIL (the headline finding a diff cannot show)", () => {
  // The definition changed. Its one proven caller did not.
  const v = adjudicate(
    contract({ known_traps: [], drift_candidates: [] }),
    actual(["agents/entire-agent-kiro/internal/protocol/protocol.go"]),
  );
  assert.equal(v.status, "FAIL");
  assert.equal(v.forgotten.length, 1);
  assert.equal(v.forgotten[0].symbol, "TestHandlerRoundTripForCoreProtocolCommands");
  assert.equal(v.forgotten[0].relation, "CALLS");
  // The finding must carry a command a reviewer can re-run.
  assert.match(v.forgotten[0].provenance.command, /entire graph impact/);
  assert.equal(v.out_of_bounds.length, 0);
});

test("out-of-bounds edit -> FAIL", () => {
  const v = adjudicate(
    contract({ known_traps: [], drift_candidates: [] }),
    actual([
      "agents/entire-agent-kiro/internal/protocol/protocol.go",
      "agents/entire-agent-kiro/internal/protocol/handlers_test.go",
      "README.md", // never proved reachable from the target
    ]),
  );
  assert.equal(v.status, "FAIL");
  assert.equal(v.forgotten.length, 0);
  assert.deepEqual(v.out_of_bounds.map((o) => o.path), ["README.md"]);
});

test("clean change inside the radius -> PASS", () => {
  const v = adjudicate(
    contract({ known_traps: [], drift_candidates: [] }),
    actual([
      "agents/entire-agent-kiro/internal/protocol/protocol.go",
      "agents/entire-agent-kiro/internal/protocol/handlers_test.go",
    ]),
  );
  assert.equal(v.status, "PASS");
  assert.deepEqual(v.out_of_bounds, []);
  assert.deepEqual(v.forgotten, []);
  assert.equal(v.in_bounds.length, 2);
});

test("trap touched and heuristic drift -> WARN, never FAIL", () => {
  // Both signals present, both heuristic. A heuristic relation must never on
  // its own escalate to FAIL -- TESTS and FILE_CHANGES_WITH are hints.
  const v = adjudicate(
    contract(),
    actual([
      "agents/entire-agent-kiro/internal/protocol/protocol.go",
      "agents/entire-agent-kiro/internal/protocol/handlers_test.go",
    ]),
  );
  assert.equal(v.status, "WARN");
  assert.equal(v.traps_hit.length, 1);
  assert.equal(v.traps_hit[0].checkpoint_id, "ckpt-1");
  assert.equal(v.traps_hit[0].provenance.confidence, "heuristic");
  // Cross-module drift: a sibling copy nothing links, left behind.
  assert.deepEqual(v.drift_candidates.map((d) => d.path), [
    "agents/entire-agent-amp/internal/protocol/protocol.go",
  ]);
});

test("no checkpoint history -> still adjudicates, degradation disclosed", () => {
  // Graph alone is a valid contract. We must not present the thin result as
  // complete, and we must not fabricate traps we could not read.
  const v = adjudicate(
    contract({
      known_traps: [],
      drift_candidates: [],
      degraded: ["no checkpoint history on this branch - traps not assessed"],
    }),
    actual([
      "agents/entire-agent-kiro/internal/protocol/protocol.go",
      "agents/entire-agent-kiro/internal/protocol/handlers_test.go",
    ]),
  );
  assert.equal(v.status, "WARN");
  assert.deepEqual(v.traps_hit, []);
  assert.match(v.degraded[0], /no checkpoint history/);
});

test("windows separators from git are normalised before comparison", () => {
  const v = adjudicate(
    contract({ known_traps: [], drift_candidates: [] }),
    actual([
      "agents\\entire-agent-kiro\\internal\\protocol\\protocol.go",
      "agents\\entire-agent-kiro\\internal\\protocol\\handlers_test.go",
    ]),
  );
  assert.equal(normalisePath("a\\b"), "a/b");
  assert.equal(v.status, "PASS");
});

test("fail_on policy is data, not control flow -- a curveball is a config change", () => {
  // Same inputs, different policy: forgotten demoted from FAIL to WARN.
  const c = contract({ known_traps: [], drift_candidates: [] });
  const changes = actual(["agents/entire-agent-kiro/internal/protocol/protocol.go"]);
  assert.equal(adjudicate(c, changes).status, "FAIL");
  const lenient = adjudicate(c, changes, { ...DEFAULT_POLICY, fail_on: ["out_of_bounds"] });
  assert.equal(lenient.status, "WARN");
  assert.equal(lenient.forgotten.length, 1);
});
