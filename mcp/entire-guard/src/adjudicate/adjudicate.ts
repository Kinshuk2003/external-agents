/**
 * The adjudicator.
 *
 * This is a pure function: (contract, actualChanges, policy) -> Verdict.
 * It performs no I/O, shells out to nothing, and reads no clock. That is a
 * deliberate testability decision -- it is unit-testable against fixtures with
 * zero CLI dependency, and it is the same code path a CI entrypoint would use
 * without an MCP server anywhere in sight.
 *
 * The logic is set arithmetic over file paths. Same inputs -> same verdict,
 * byte for byte. No model in the critical path.
 */
import type {
  ActualChanges,
  ChangeContract,
  Policy,
  Verdict,
} from "../types.js";

/**
 * Normalise a path for comparison: forward slashes, no leading "./".
 * Windows and git disagree about separators; the adjudicator must not care.
 */
export function normalisePath(p: string): string {
  return p.split("\\").join("/").replace(/^\.\//, "").trim();
}

function isAlwaysAllowed(path: string, policy: Policy): boolean {
  return policy.always_allowed.some(
    (prefix) => path === prefix || path.startsWith(normalisePath(prefix)),
  );
}

/** Go/TS/Python test-file heuristics, used only when policy.exclude_tests is on. */
function looksLikeTest(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(path) || /(_test\.|\.test\.|\.spec\.)/.test(path);
}

export function adjudicate(
  contract: ChangeContract,
  actual: ActualChanges,
  policy: Policy = contract.policy,
): Verdict {
  const changed = new Set(actual.changed_files.map(normalisePath));

  // The legitimate blast radius: everything the graph proved reachable, plus
  // the obliged callers, plus the target file itself.
  const allowed = new Set<string>();
  for (const f of contract.allowed_files) allowed.add(normalisePath(f.path));
  for (const m of contract.must_update) allowed.add(normalisePath(m.path));
  if (contract.target.file) allowed.add(normalisePath(contract.target.file));

  const out_of_bounds: Verdict["out_of_bounds"] = [];
  const in_bounds: string[] = [];

  for (const path of changed) {
    if (allowed.has(path) || isAlwaysAllowed(path, policy)) {
      in_bounds.push(path);
      continue;
    }
    if (policy.exclude_tests && looksLikeTest(path)) {
      in_bounds.push(path);
      continue;
    }
    out_of_bounds.push({
      path,
      note: "edited, but not in the blast radius proved by graph impact for " + contract.target.symbol,
      provenance: {
        source: "git",
        command: `git diff --name-only ${contract.base_sha}`,
        confidence: "deterministic",
      },
    });
  }

  // The headline finding: a direct caller that was obliged to change and did not.
  // A diff cannot show this, because the evidence is an absence.
  const forgotten: Verdict["forgotten"] = [];
  for (const m of contract.must_update) {
    const path = normalisePath(m.path);
    if (changed.has(path)) continue;
    if (policy.exclude_tests && looksLikeTest(path)) continue;
    forgotten.push({
      path,
      symbol: m.symbol,
      relation: m.relation,
      provenance: m.provenance,
    });
  }

  // Heuristic: historically co-changing files left untouched. This is how
  // cross-module drift shows up (separate modules, so no compiler links them).
  // FILE_CHANGES_WITH is a heuristic relation -- WARN only, never FAIL.
  const drift_candidates: Verdict["drift_candidates"] = [];
  if (changed.size > 0) {
    for (const d of contract.drift_candidates) {
      const path = normalisePath(d.path);
      if (changed.has(path)) continue;
      drift_candidates.push({ path, detail: d.detail, provenance: d.provenance });
    }
  }

  // A known unresolved risk in territory this change touched.
  const traps_hit: Verdict["traps_hit"] = [];
  for (const trap of contract.known_traps) {
    for (const f of trap.files) {
      const path = normalisePath(f);
      if (!changed.has(path)) continue;
      traps_hit.push({
        text: trap.text,
        checkpoint_id: trap.checkpoint_id,
        path,
        provenance: trap.provenance,
      });
      break;
    }
  }

  // ---------------------------------------------------------------------
  // Claim reconciliation -- the Noon Curveball half.
  //
  // The rule enforced here is ADDITIVE-ONLY: session evidence may only ever
  // add findings. It never discharges an obligation, never shrinks
  // out_of_bounds, and never removes anything. That is what makes
  //
  //     severity(git + session) >= severity(git)
  //
  // true by construction rather than by test coverage -- and it is why a
  // truncated transcript, which yields fewer claims, cannot turn a FAIL into
  // a PASS.
  // ---------------------------------------------------------------------
  const session = actual.session;

  const out_of_bounds_by_claim: Verdict["out_of_bounds_by_claim"] = [];
  const unverified_claims: Verdict["unverified_claims"] = [];
  const unclaimed_changes: Verdict["unclaimed_changes"] = [];
  const sessionDegraded: string[] = [];

  let evidence_basis: Verdict["evidence_basis"] = "deterministic";

  if (session) {
    evidence_basis = actual.git_unavailable ? "claimed_only" : "reconciled";

    const claimed = new Map(
      session.claimed_changes.map((c) => [normalisePath(c.path), c] as const),
    );
    const alreadyFailedByGit = new Set(out_of_bounds.map((o) => o.path));

    for (const [path, change] of claimed) {
      const inRadius =
        allowed.has(path) ||
        isAlwaysAllowed(path, policy) ||
        (policy.exclude_tests && looksLikeTest(path));

      if (!inRadius) {
        // The stronger deterministic finding subsumes the weaker claimed one,
        // exactly as a proven caller subsumes a heuristic co-change.
        if (alreadyFailedByGit.has(path)) continue;
        out_of_bounds_by_claim.push({
          path,
          note:
            "the agent's own transcript reports " +
            change.kind +
            " this file, which is outside the blast radius proved for " +
            contract.target.symbol +
            " (transcript line " +
            change.line +
            ")",
          provenance: session.provenance,
        });
        continue;
      }

      if (!changed.has(path)) {
        unverified_claims.push({
          path,
          note:
            "claimed " +
            change.kind +
            " at transcript line " +
            change.line +
            ", but the diff against " +
            contract.base_sha +
            " does not show it; the claim could not be confirmed here",
          provenance: session.provenance,
        });
      }
    }

    for (const path of changed) {
      if (claimed.has(path)) continue;
      if (isAlwaysAllowed(path, policy)) continue;
      unclaimed_changes.push({
        path,
        note:
          "changed on disk but never mentioned in the transcript; an edit made " +
          "outside the agent session, or one the transcript did not record",
        provenance: session.provenance,
      });
    }

    // The transcript's own degradation is the verdict's degradation. An
    // unreadable line or an unrecognised event is a gap in what we know.
    sessionDegraded.push(...session.degraded);

    if (evidence_basis === "claimed_only") {
      sessionDegraded.push(
        "verdict rests on claimed transcript evidence only: git evidence for the change set was " +
          "unavailable, so no claim could be confirmed against disk. PASS is not available on " +
          "this basis.",
      );
    }

    if (session.repo && !contract.repo_root.split("\\").join("/").includes(session.repo)) {
      sessionDegraded.push(
        'transcript reports repository "' +
          session.repo +
          '" which does not match the contract repo_root "' +
          contract.repo_root +
          '"; claimed paths may be relative to a different checkout, so the claim findings ' +
          "below may reflect that mismatch rather than a real breach",
      );
    }
  }

  const degraded = [...contract.degraded, ...actual.degraded];
  degraded.push(...sessionDegraded);


  const failing =
    (policy.fail_on.includes("out_of_bounds") && out_of_bounds.length > 0) ||
    (policy.fail_on.includes("forgotten") && forgotten.length > 0) ||
    (policy.fail_on.includes("out_of_bounds_by_claim") && out_of_bounds_by_claim.length > 0) ||
    (policy.fail_on_degraded && degraded.length > 0);

  const warning =
    traps_hit.length > 0 ||
    drift_candidates.length > 0 ||
    out_of_bounds.length > 0 ||
    forgotten.length > 0 ||
    out_of_bounds_by_claim.length > 0 ||
    unverified_claims.length > 0 ||
    unclaimed_changes.length > 0 ||
    degraded.length > 0;

  let status: Verdict["status"] = failing ? "FAIL" : warning ? "WARN" : "PASS";

  // Incomplete context is never presented as an authoritative result: with no
  // git evidence to confirm a single claim, a clean PASS would be a fabrication.
  if (evidence_basis === "claimed_only" && status === "PASS") status = "WARN";

  return {
    status,
    evidence_basis,
    out_of_bounds,
    out_of_bounds_by_claim,
    unverified_claims,
    unclaimed_changes,
    forgotten,
    drift_candidates,
    traps_hit,
    in_bounds: in_bounds.sort(),
    semantic_changes: actual.semantic_changes,
    degraded,
    contract_id: contract.id,
    base_sha: contract.base_sha,
    head_sha: actual.head_sha,
  };
}
