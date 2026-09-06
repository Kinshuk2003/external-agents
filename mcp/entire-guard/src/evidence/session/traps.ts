/**
 * Traps recalled from a transcript's own checkpoint events.
 *
 * The Track 3 card requires existing Checkpoint behaviour to stay compatible.
 * It does: the `entire checkpoint explain` path in `evidence/checkpoints.ts` is
 * untouched. This is a *second source* feeding the same `KnownTrap` type, so
 * `propose_change`, the adjudicator and the formatter need no knowledge that a
 * trap can now come from a transcript.
 *
 * One asymmetry is worth naming, because it runs the opposite way to the rest
 * of this feature. The CLI path has to keyword-match unresolved work out of
 * checkpoint prose, and its recall is therefore limited. The new transcript
 * format carries `open_questions[]` as a first-class field: the agent declared
 * these as unresolved, so no scraping is involved. The provenance stays
 * "claimed" because the agent authored it about its own work -- but it is a
 * structured claim rather than a guess about prose.
 */
import type { AgentSession, KnownTrap } from "../../types.js";

export type SessionTrapEvidence = { traps: KnownTrap[]; degraded: string[] };

export function trapsFromSession(session: AgentSession): SessionTrapEvidence {
  const traps: KnownTrap[] = [];
  const degraded: string[] = [];

  // The files this session says it touched. A trap raised by the session is
  // relevant to the territory the session worked in, which is what lets
  // `traps_hit` fire later if that territory is edited again.
  const files = session.claimed_changes.map((c) => c.path);

  for (const checkpoint of session.checkpoints) {
    for (const question of checkpoint.open_questions) {
      traps.push({
        text: question,
        checkpoint_id: checkpoint.checkpoint_id,
        files,
        provenance: session.provenance,
      });
    }
  }

  if (session.checkpoints.length === 0) {
    degraded.push(
      `transcript ${session.source} records no checkpoint events, so no open questions were ` +
        "recalled from it; checkpoint history from the Entire CLI is unaffected",
    );
  } else if (traps.length === 0) {
    degraded.push(
      `transcript ${session.source} records ${session.checkpoints.length} checkpoint event(s) but ` +
        "none carried open questions",
    );
  }

  if (!session.complete) {
    degraded.push(
      `transcript ${session.source} is incomplete, so open questions raised after the point of ` +
        "truncation are missing from this contract",
    );
  }

  return { traps, degraded };
}
