/**
 * Human-readable rendering. Every finding prints the command that produced it,
 * so any line of this output can be independently re-run and checked.
 */
import type { ChangeContract, Verdict } from "./types.js";

/**
 * Say what the basis means, not just what it is called.
 *
 * The card requires the interface to distinguish complete from incomplete
 * context. A bare label does not do that for a reader who has never seen the
 * type, so the constraint is spelled out where the verdict is read.
 */
function basisNote(basis: Verdict["evidence_basis"]): string {
  switch (basis) {
    case "deterministic":
      return " (git diff only; no agent transcript was supplied)";
    case "reconciled":
      return " (git diff cross-checked against the agent's transcript)";
    case "claimed_only":
      return " - no git evidence for this change set, so nothing could be confirmed against disk. This CANNOT BE A PASS.";
  }
}

function bullet(lines: string[]): string {
  return lines.length ? lines.map((l) => `  - ${l}`).join("\n") : "  (none)";
}

export function formatContract(contract: ChangeContract, file: string): string {
  const out: string[] = [];
  out.push(`CHANGE CONTRACT ${contract.id}`);
  out.push(`target        ${contract.target.symbol}${contract.target.file ? ` @ ${contract.target.file}:${contract.target.line ?? "?"}` : ""}`);
  out.push(`base commit   ${contract.base_sha}`);
  out.push(`stored at     ${file}`);
  out.push("");

  out.push(`MUST UPDATE (${contract.must_update.length}) - direct callers, deterministic. Not touching these FAILS verification.`);
  out.push(
    bullet(contract.must_update.map((m) => `${m.path}  ->  ${m.symbol}  [${m.relation}]`)),
  );
  out.push("");

  out.push(`ALLOWED FILES (${contract.allowed_files.length}) - the proven blast radius. Editing outside this FAILS verification.`);
  out.push(
    bullet(
      contract.allowed_files.map(
        (f) => `${f.path}  (${f.reason})${f.provenance.confidence === "heuristic" ? "  [heuristic]" : ""}`,
      ),
    ),
  );
  out.push("");

  out.push(`DRIFT CANDIDATES (${contract.drift_candidates.length}) - co-change history, HEURISTIC. Warns only, never fails.`);
  out.push(bullet(contract.drift_candidates.map((d) => `${d.path}  (${d.detail})`)));
  out.push("");

  out.push(`KNOWN TRAPS (${contract.known_traps.length}) - unresolved work recalled from checkpoints. HEURISTIC.`);
  out.push(
    bullet(contract.known_traps.map((t) => `[${t.checkpoint_id}] ${t.text}`)),
  );
  out.push("");

  out.push(`DEGRADED (${contract.degraded.length}) - what could NOT be determined:`);
  out.push(bullet(contract.degraded));
  out.push("");

  const commands = new Set<string>();
  for (const f of contract.allowed_files) commands.add(f.provenance.command);
  for (const t of contract.known_traps) commands.add(t.provenance.command);
  out.push("EVIDENCE - re-run any of these to check this contract yourself:");
  out.push(bullet([...commands]));
  out.push("");
  out.push(`When you are done editing, call verify_change with contract_id "${contract.id}".`);
  return out.join("\n");
}

export function formatVerdict(verdict: Verdict): string {
  const out: string[] = [];
  const headline =
    verdict.status === "FAIL"
      ? "FAIL - this change does not honour its contract"
      : verdict.status === "WARN"
        ? "WARN - contract honoured, but with unverified risk"
        : "PASS - change stayed inside its contract";
  out.push(`VERDICT: ${headline}`);
  out.push(`contract ${verdict.contract_id}   base ${verdict.base_sha.slice(0, 8)} -> head ${verdict.head_sha.slice(0, 8)}`);
  out.push(`EVIDENCE BASIS: ${verdict.evidence_basis}${basisNote(verdict.evidence_basis)}`);
  out.push("");

  out.push(`FORGOTTEN (${verdict.forgotten.length}) - a proven caller that was obliged to change and did not.`);
  out.push(
    bullet(
      verdict.forgotten.map(
        (f) => `${f.path}  ->  ${f.symbol}  [${f.relation}]\n    evidence: ${f.provenance.command}`,
      ),
    ),
  );
  out.push("");

  out.push(`OUT OF BOUNDS (${verdict.out_of_bounds.length}) - edited, but never proved reachable from the target.`);
  out.push(
    bullet(verdict.out_of_bounds.map((o) => `${o.path}\n    ${o.note}\n    evidence: ${o.provenance.command}`)),
  );
  out.push("");

  out.push(`DRIFT WARNINGS (${verdict.drift_candidates.length}) - historically co-changing, left untouched. HEURISTIC: check, do not assume.`);
  out.push(bullet(verdict.drift_candidates.map((d) => `${d.path}  (${d.detail})`)));
  out.push("");

  out.push(`TRAPS HIT (${verdict.traps_hit.length}) - you edited near known unresolved work.`);
  out.push(
    bullet(
      verdict.traps_hit.map(
        (t) => `${t.path}\n    [${t.checkpoint_id}] ${t.text}\n    evidence: ${t.provenance.command}`,
      ),
    ),
  );
  out.push("");

  // Claim-derived sections appear only when a transcript was supplied, so a
  // git-only verdict renders exactly as it did before the Curveball.
  if (verdict.out_of_bounds_by_claim.length > 0) {
    out.push(
      `OUT OF BOUNDS BY CLAIM (${verdict.out_of_bounds_by_claim.length}) - the agent's own transcript reports editing outside the radius. [CLAIMED, but the radius is deterministic]`,
    );
    out.push(
      bullet(
        verdict.out_of_bounds_by_claim.map(
          (o) => `${o.path}\n    ${o.note}\n    evidence: ${o.provenance.command}`,
        ),
      ),
    );
    out.push("");
  }

  if (verdict.unverified_claims.length > 0) {
    out.push(
      `UNVERIFIED CLAIMS (${verdict.unverified_claims.length}) - claimed in the transcript, absent from the diff. [CLAIMED] Warns only, never fails.`,
    );
    out.push(
      bullet(
        verdict.unverified_claims.map(
          (c) => `${c.path}\n    ${c.note}\n    evidence: ${c.provenance.command}`,
        ),
      ),
    );
    out.push("");
  }

  if (verdict.unclaimed_changes.length > 0) {
    out.push(
      `UNCLAIMED CHANGES (${verdict.unclaimed_changes.length}) - changed on disk, never mentioned in the transcript. [CLAIMED] Warns only, never fails.`,
    );
    out.push(
      bullet(
        verdict.unclaimed_changes.map(
          (c) => `${c.path}\n    ${c.note}\n    evidence: ${c.provenance.command}`,
        ),
      ),
    );
    out.push("");
  }

  out.push(`IN BOUNDS (${verdict.in_bounds.length}):`);
  out.push(bullet(verdict.in_bounds));
  out.push("");

  out.push(`DEGRADED (${verdict.degraded.length}) - limits on this verdict:`);
  out.push(bullet(verdict.degraded));
  out.push("");

  const sem = verdict.semantic_changes as { files?: Array<{ path: string; changes?: unknown[] }> } | undefined;
  if (sem?.files) {
    out.push(`SEMANTIC CHANGES (entire graph diff) - ${sem.files.length} file(s) changed in meaning:`);
    out.push(
      bullet(
        sem.files
          .slice(0, 25)
          .map((f) => `${f.path}  (${(f.changes ?? []).length} entity change(s))`),
      ),
    );
  } else {
    out.push("SEMANTIC CHANGES: unavailable (see DEGRADED)");
  }
  return out.join("\n");
}
