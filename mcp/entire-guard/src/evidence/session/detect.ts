/**
 * Transcript format detection.
 *
 * The rule this file exists to enforce: **refuse rather than guess.**
 *
 * Guessing a format is worse than failing to read the transcript at all. A
 * wrong guess yields zero parsed file changes and a confident-looking empty
 * session -- the same "compiled, ran, reported success, did nothing" failure
 * class this product was built to catch. So an absent or contradictory
 * discriminator returns no format and an explanation.
 */
import type { JsonlRecord } from "../exec.js";
import type { SessionFormat } from "../../types.js";

export type Detection = { format?: SessionFormat; reason: string };

/** How many records to sniff. A transcript's shape is settled by its first few lines. */
const SNIFF_LIMIT = 50;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Does this record look like the Curveball's event envelope?
 * Discriminator: a string `event`.
 */
function looksAcme(o: Record<string, unknown>): boolean {
  return typeof o["event"] === "string";
}

/**
 * Does this record look like one of the external-agent protocol structs?
 * Three discriminators, because the protocol has three record shapes:
 *   EventJSON        -> numeric `type`
 *   HookInputJSON    -> string `hook_type`
 *   AgentSessionJSON -> one of the file-list arrays, or `agent_name`
 */
function looksEntireProtocol(o: Record<string, unknown>): boolean {
  if (typeof o["type"] === "number") return true;
  if (typeof o["hook_type"] === "string") return true;
  if (typeof o["agent_name"] === "string") return true;
  return (
    Array.isArray(o["modified_files"]) ||
    Array.isArray(o["new_files"]) ||
    Array.isArray(o["deleted_files"])
  );
}

export function detectFormat(records: JsonlRecord[]): Detection {
  if (records.length === 0) {
    return {
      reason:
        "could not determine the transcript format: no readable JSONL records (the file is empty, or every line failed to parse)",
    };
  }

  let acme = 0;
  let protocol = 0;

  for (const record of records.slice(0, SNIFF_LIMIT)) {
    if (!isObject(record.value)) continue;
    if (looksAcme(record.value)) acme += 1;
    if (looksEntireProtocol(record.value)) protocol += 1;
  }

  if (acme > 0 && protocol > 0) {
    return {
      reason:
        `transcript format is ambiguous: ${acme} record(s) carry a string "event" (new format) and ` +
        `${protocol} carry a numeric "type" / "hook_type" / file-list field (original format). ` +
        "Refusing to guess -- split the transcript, or supply the one the agent actually wrote.",
    };
  }

  if (acme > 0) return { format: "acme-events", reason: `${acme} string-tagged event record(s)` };
  if (protocol > 0) {
    return { format: "entire-protocol", reason: `${protocol} protocol record(s)` };
  }

  return {
    reason:
      `could not determine the transcript format: ${records.length} record(s) parsed as JSON but none ` +
      'carried a recognised discriminator (a string "event", or a numeric "type" / "hook_type" / file-list field)',
  };
}
