/**
 * Claim-reconciliation tests -- the Noon Curveball half of the adjudicator.
 *
 * The last test in this file is the one that matters most. It is a property
 * test over a matrix of contracts, diffs and transcripts, asserting the safety
 * invariant the revised design rests on:
 *
 *     severity(verdict | git + session) >= severity(verdict | git)
 *
 * If that ever fails, an incomplete transcript can lower a verdict -- which is
 * the exact failure this feature was designed not to introduce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { adjudicate } from "./adjudicate.js";
import {
  DEFAULT_POLICY,
  type ActualChanges,
  type AgentSession,
  type ChangeContract,
  type ClaimedChange,
  type Provenance,
  type Verdict,
} from "../types.js";

const DET: Provenance = {
  source: "graph.impact",
  command: "entire graph impact --symbol applyCoupon --repo . --depth 2 --profile full --format json",
  confidence: "deterministic",
};

const IN_RADIUS = "src/checkout/apply_coupon.ts";
const OBLIGED = "src/checkout/cart_total.ts";
const OUTSIDE = "src/billing/invoice.ts";

function contract(overrides: Partial<ChangeContract> = {}): ChangeContract {
  return {
    id: "ct-claims",
    created_at: "2026-09-06T00:00:00.000Z",
    repo_root: "/repo",
    base_sha: "base123",
    target: { symbol: "applyCoupon", file: IN_RADIUS },
    allowed_files: [
      { path: IN_RADIUS, reason: "definition site", provenance: DET },
      { path: OBLIGED, reason: "direct caller", provenance: DET },
    ],
    must_update: [{ path: OBLIGED, symbol: "cartTotal", relation: "CALLS", provenance: DET }],
    drift_candidates: [],
    known_traps: [],
    degraded: [],
    policy: DEFAULT_POLICY,
    ...overrides,
  };
}

function claim(path: string, kind: ClaimedChange["kind"] = "modified"): ClaimedChange {
  return { path, kind, line: 7, events: 1 };
}

function session(claims: ClaimedChange[], overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    format: "acme-events",
    source: "fixture.jsonl",
    session_id: "s-1",
    claimed_changes: claims,
    lifecycle: { started: true, ended: true, status: "completed" },
    checkpoints: [],
    unknown_events: [],
    records_parsed: claims.length + 2,
    complete: true,
    degraded: [],
    provenance: {
      source: "transcript",
      command: "read agent session transcript fixture.jsonl",
      confidence: "claimed",
    },
    ...overrides,
  };
}

function actual(changed: string[], overrides: Partial<ActualChanges> = {}): ActualChanges {
  return {
    changed_files: changed,
    semantic_changes: undefined,
    head_sha: "head456",
    degraded: [],
    provenance: [],
    ...overrides,
  };
}

const RANK: Record<Verdict["status"], number> = { PASS: 0, WARN: 1, FAIL: 2 };

// ---------------------------------------------------------------------------
// evidence_basis
// ---------------------------------------------------------------------------

test("with no session supplied the verdict is deterministic and the claim buckets are empty", () => {
  const v = adjudicate(contract(), actual([IN_RADIUS, OBLIGED]));

  assert.equal(v.evidence_basis, "deterministic");
  assert.deepEqual(v.out_of_bounds_by_claim, []);
  assert.deepEqual(v.unverified_claims, []);
  assert.deepEqual(v.unclaimed_changes, []);
  assert.equal(v.status, "PASS");
});

test("with both sources present the verdict is reconciled", () => {
  const v = adjudicate(
    contract(),
    actual([IN_RADIUS, OBLIGED], { session: session([claim(IN_RADIUS), claim(OBLIGED)]) }),
  );

  assert.equal(v.evidence_basis, "reconciled");
  assert.equal(v.status, "PASS");
});

test("when git evidence is unavailable the basis is claimed_only", () => {
  const v = adjudicate(
    contract({ must_update: [] }),
    actual([], { git_unavailable: true, session: session([claim(IN_RADIUS)]) }),
  );

  assert.equal(v.evidence_basis, "claimed_only");
});

test("a claimed_only verdict can never be PASS", () => {
  const v = adjudicate(
    contract({ must_update: [], allowed_files: [{ path: IN_RADIUS, reason: "target", provenance: DET }] }),
    actual([], { git_unavailable: true, session: session([claim(IN_RADIUS)]) }),
  );

  assert.notEqual(v.status, "PASS");
  assert.ok(
    v.degraded.some((d) => d.toLowerCase().includes("claimed")),
    `degraded should explain the claim-only basis, got ${JSON.stringify(v.degraded)}`,
  );
});

// ---------------------------------------------------------------------------
// The three new finding classes
// ---------------------------------------------------------------------------

test("a claimed edit git cannot confirm is reported as an unverified claim", () => {
  const v = adjudicate(
    contract({ must_update: [] }),
    actual([IN_RADIUS], { session: session([claim(IN_RADIUS), claim(OBLIGED)]) }),
  );

  assert.deepEqual(
    v.unverified_claims.map((c) => c.path),
    [OBLIGED],
  );
});

test("an unverified claim alone is a WARN, never a FAIL", () => {
  const v = adjudicate(
    contract({ must_update: [] }),
    actual([IN_RADIUS], { session: session([claim(IN_RADIUS), claim(OBLIGED)]) }),
  );

  assert.equal(v.status, "WARN");
});

test("a git change the transcript never mentions is reported as unclaimed", () => {
  const v = adjudicate(
    contract(),
    actual([IN_RADIUS, OBLIGED], { session: session([claim(IN_RADIUS)]) }),
  );

  assert.deepEqual(
    v.unclaimed_changes.map((c) => c.path),
    [OBLIGED],
  );
  assert.equal(v.status, "WARN", "an out-of-band edit warns, it does not fail");
});

test("the agent claiming an edit outside the contract radius is a FAIL", () => {
  const v = adjudicate(
    contract(),
    actual([IN_RADIUS, OBLIGED], { session: session([claim(IN_RADIUS), claim(OUTSIDE)]) }),
  );

  assert.deepEqual(
    v.out_of_bounds_by_claim.map((c) => c.path),
    [OUTSIDE],
  );
  assert.equal(v.status, "FAIL");
});

test("an out-of-bounds claim is not double-reported as an unverified claim", () => {
  const v = adjudicate(
    contract(),
    actual([IN_RADIUS, OBLIGED], { session: session([claim(OUTSIDE)]) }),
  );

  assert.equal(
    v.unverified_claims.some((c) => c.path === OUTSIDE),
    false,
    "the stronger out-of-bounds finding subsumes the weaker unverified one",
  );
});

// ---------------------------------------------------------------------------
// The additive-only rule
// ---------------------------------------------------------------------------

test("a claimed edit does NOT discharge a must_update obligation", () => {
  // git shows only the definition edited; the transcript *claims* the obliged
  // caller was updated too. If the claim were allowed to satisfy the
  // obligation, a lying or truncated transcript would turn this FAIL into a PASS.
  const v = adjudicate(
    contract(),
    actual([IN_RADIUS], { session: session([claim(IN_RADIUS), claim(OBLIGED)]) }),
  );

  assert.deepEqual(
    v.forgotten.map((f) => f.path),
    [OBLIGED],
    "the obligation is still outstanding: only git can discharge it",
  );
  assert.equal(v.status, "FAIL");
});

test("a truncated transcript cannot turn a FAIL into a PASS", () => {
  const base = adjudicate(contract(), actual([IN_RADIUS]));
  assert.equal(base.status, "FAIL", "baseline: the obliged caller was not edited");

  const truncated = session([], {
    complete: false,
    lifecycle: { started: true, ended: false },
    degraded: ["transcript line 5 could not be parsed"],
  });
  const withTruncated = adjudicate(contract(), actual([IN_RADIUS], { session: truncated }));

  assert.equal(withTruncated.status, "FAIL");
});

test("an incomplete session is disclosed in the verdict's degraded list", () => {
  const incomplete = session([claim(IN_RADIUS)], {
    complete: false,
    lifecycle: { started: true, ended: false },
    degraded: ["transcript has no session-end event"],
  });
  const v = adjudicate(contract({ must_update: [] }), actual([IN_RADIUS], { session: incomplete }));

  assert.ok(
    v.degraded.some((d) => d.includes("session-end")),
    `the transcript's own degradation must reach the verdict, got ${JSON.stringify(v.degraded)}`,
  );
  assert.notEqual(v.status, "PASS", "an incomplete transcript cannot yield a clean PASS");
});

// ---------------------------------------------------------------------------
// THE SAFETY INVARIANT
// ---------------------------------------------------------------------------

test("property: adding session evidence never lowers the verdict severity", () => {
  const contracts = [
    contract(),
    contract({ must_update: [] }),
    contract({
      drift_candidates: [
        { path: "src/promotions/coupon.ts", detail: "co-changed in 3 commits", provenance: DET },
      ],
    }),
  ];

  const diffs = [[], [IN_RADIUS], [IN_RADIUS, OBLIGED], [IN_RADIUS, OBLIGED, OUTSIDE]];

  const sessions: AgentSession[] = [
    session([]),
    session([claim(IN_RADIUS)]),
    session([claim(IN_RADIUS), claim(OBLIGED)]),
    session([claim(OUTSIDE)]),
    session([claim(IN_RADIUS), claim(OBLIGED), claim(OUTSIDE)]),
    session([claim(IN_RADIUS)], {
      complete: false,
      lifecycle: { started: true, ended: false },
      degraded: ["truncated"],
    }),
    session([], {
      complete: false,
      unknown_events: [{ name: "thinking_block", count: 3, first_line: 2 }],
      degraded: ["unrecognised event kinds"],
    }),
  ];

  let checked = 0;
  for (const c of contracts) {
    for (const d of diffs) {
      const baseline = adjudicate(c, actual(d));
      for (const s of sessions) {
        const withSession = adjudicate(c, actual(d, { session: s }));
        assert.ok(
          RANK[withSession.status] >= RANK[baseline.status],
          `session evidence lowered the verdict from ${baseline.status} to ${withSession.status} ` +
            `for diff [${d.join(", ")}] and claims [${s.claimed_changes
              .map((x) => x.path)
              .join(", ")}]`,
        );
        checked += 1;
      }
    }
  }

  assert.equal(checked, contracts.length * diffs.length * sessions.length);
  assert.equal(checked, 84, "the matrix actually ran");
});
