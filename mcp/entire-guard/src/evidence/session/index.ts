/**
 * Session transcript evidence -- the entry point.
 *
 * Added for the Noon Curveball. Before it, entire-guard learned what an agent
 * changed from exactly one source with no format at all: `git diff --name-only`.
 * That source is still here and still deterministic; this one sits *beside* it
 * and is explicitly weaker -- a transcript is the agent's own account, so every
 * claim it yields carries `confidence: "claimed"`.
 *
 * The registry below is the extension point. A third format is one reader file
 * and one row.
 */
import { readFile } from "node:fs/promises";
import { parseJsonl } from "../exec.js";
import { detectFormat } from "./detect.js";
import { readAcmeEvents } from "./readers/acme-events.js";
import { readEntireProtocol } from "./readers/entire-protocol.js";
import type { Accumulator } from "./normalize.js";
import type { JsonlRecord } from "../exec.js";
import type { AgentSession, Provenance, SessionEvidence, SessionFormat } from "../../types.js";

/** The only place that maps a detected format to the code that reads it. */
const READERS: Record<SessionFormat, (records: JsonlRecord[]) => Accumulator> = {
  "acme-events": readAcmeEvents,
  "entire-protocol": readEntireProtocol,
};

function provenanceFor(source: string): Provenance {
  return {
    source: "transcript",
    command: `read agent session transcript ${source}`,
    confidence: "claimed",
  };
}

/**
 * Read a transcript into the normalised session shape.
 *
 * Pure: text in, evidence out. No filesystem, no clock -- the same testability
 * decision the adjudicator rests on.
 *
 * Never throws. An unreadable line, an unknown event and an unrecognisable
 * format are three different outcomes and all three are reported rather than
 * raised, because the card requires an incomplete transcript to yield a partial
 * result rather than a discarded session.
 */
export function parseSession(text: string, source: string): SessionEvidence {
  const provenance = provenanceFor(source);
  const parsed = parseJsonl(text);
  const detection = detectFormat(parsed.records);

  if (!detection.format) {
    // A refusal, not an empty session. Guessing would report zero claims with
    // total confidence, which is the worst answer available.
    return { degraded: [detection.reason], provenance };
  }

  const acc = READERS[detection.format](parsed.records);
  const degraded: string[] = [];

  for (const failure of parsed.failures) {
    degraded.push(
      `transcript line ${failure.line} could not be parsed (${failure.error}); ` +
        "any file change it reported was NOT counted",
    );
  }

  if (acc.unknown.size > 0) {
    const names = [...acc.unknown.values()]
      .map((u) => `${u.name} x${u.count} (first at line ${u.first_line})`)
      .join(", ");
    degraded.push(
      `transcript contained ${acc.unknown.size} unrecognised event kind(s): ${names}. ` +
        "They were not read, so any file change they carried was not counted",
    );
  }

  if (!acc.lifecycle.started) {
    degraded.push("transcript has no session-start event; it may begin mid-session");
  }
  if (!acc.lifecycle.ended) {
    degraded.push(
      "transcript has no session-end event; the session was interrupted or is still running, " +
        "so later file changes may be missing",
    );
  }

  // Complete means both: it ended cleanly AND every line was readable.
  const complete = acc.lifecycle.ended && parsed.failures.length === 0;

  const session: AgentSession = {
    format: detection.format,
    source,
    ...(acc.session_id ? { session_id: acc.session_id } : {}),
    ...(acc.agent ? { agent: acc.agent } : {}),
    ...(acc.repo ? { repo: acc.repo } : {}),
    claimed_changes: [...acc.claims.values()].sort((a, b) => a.path.localeCompare(b.path)),
    lifecycle: acc.lifecycle,
    checkpoints: acc.checkpoints,
    unknown_events: [...acc.unknown.values()],
    records_parsed: parsed.records.length,
    complete,
    degraded,
    provenance,
  };

  return { session, degraded, provenance };
}

/**
 * Read a transcript from disk.
 *
 * A missing or unreadable file degrades rather than throws. The caller may have
 * supplied a path that does not exist, and that must not take down a
 * verification which git evidence alone can still answer.
 */
export async function loadSession(filePath: string): Promise<SessionEvidence> {
  try {
    const text = await readFile(filePath, "utf8");
    return parseSession(text, filePath);
  } catch (err) {
    return {
      degraded: [
        `could not read agent session transcript ${filePath} ` +
          `(${err instanceof Error ? err.message : String(err)}); ` +
          "the verdict rests on git evidence alone",
      ],
      provenance: provenanceFor(filePath),
    };
  }
}

export { detectFormat } from "./detect.js";
