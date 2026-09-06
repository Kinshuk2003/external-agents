/**
 * Rendering tests for the Curveball's new verdict buckets.
 *
 * The interface has to distinguish complete from incomplete context, so the
 * evidence basis is rendered as a banner rather than buried in a field, and
 * every claim-derived row is labelled [CLAIMED] so nobody mistakes the agent's
 * self-report for an observation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { formatVerdict } from "./format.js";
import type { Provenance, Verdict } from "./types.js";

const CLAIM: Provenance = {
  source: "transcript",
  command: "read agent session transcript test/fixtures/track-3-agent-session.jsonl",
  confidence: "claimed",
};

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    status: "PASS",
    evidence_basis: "deterministic",
    out_of_bounds: [],
    out_of_bounds_by_claim: [],
    unverified_claims: [],
    unclaimed_changes: [],
    forgotten: [],
    drift_candidates: [],
    traps_hit: [],
    in_bounds: [],
    semantic_changes: undefined,
    degraded: [],
    contract_id: "ct-fmt",
    base_sha: "abcdef1234",
    head_sha: "1234abcdef",
    ...overrides,
  };
}

test("the evidence basis is rendered so a reader sees what the verdict rests on", () => {
  const text = formatVerdict(verdict({ evidence_basis: "reconciled" }));

  assert.ok(text.includes("EVIDENCE BASIS"), text.slice(0, 300));
  assert.ok(text.includes("reconciled"), text.slice(0, 300));
});

test("a claimed_only verdict says in words that it cannot be authoritative", () => {
  const text = formatVerdict(verdict({ status: "WARN", evidence_basis: "claimed_only" }));

  assert.ok(
    text.toLowerCase().includes("cannot be a pass"),
    "the banner must state the constraint, not just the label",
  );
});

test("an out-of-bounds claim renders with its transcript evidence", () => {
  const text = formatVerdict(
    verdict({
      status: "FAIL",
      out_of_bounds_by_claim: [
        { path: "src/billing/invoice.ts", note: "outside the proved radius", provenance: CLAIM },
      ],
    }),
  );

  assert.ok(text.includes("OUT OF BOUNDS BY CLAIM (1)"), text);
  assert.ok(text.includes("src/billing/invoice.ts"), text);
  assert.ok(text.includes(CLAIM.command), "the provenance command must be printed");
});

test("claim-derived rows are labelled so a self-report is never read as an observation", () => {
  const text = formatVerdict(
    verdict({
      status: "WARN",
      unverified_claims: [{ path: "a.ts", note: "not in the diff", provenance: CLAIM }],
      unclaimed_changes: [{ path: "b.ts", note: "not in the transcript", provenance: CLAIM }],
    }),
  );

  assert.ok(text.includes("UNVERIFIED CLAIMS (1)"), text);
  assert.ok(text.includes("UNCLAIMED CHANGES (1)"), text);
  assert.ok(text.includes("CLAIMED"), "claim rows must carry a confidence label");
});

test("with no session the claim sections stay out of the way", () => {
  const text = formatVerdict(verdict());

  assert.equal(
    text.includes("OUT OF BOUNDS BY CLAIM"),
    false,
    "a git-only verdict should render exactly as it did before the Curveball",
  );
  assert.equal(text.includes("UNVERIFIED CLAIMS"), false);
});
