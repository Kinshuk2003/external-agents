/**
 * Reader for the NEW format introduced by the Noon Curveball.
 *
 * A string-tagged event envelope, one JSON object per line, with file changes
 * arriving as a **stream**: one `file_changed` event per edit, so a file edited
 * twice appears twice.
 *
 * This file is one of only two places in the codebase that knows a transcript
 * format exists. Everything downstream -- reconciliation, adjudication,
 * formatting, both transports -- works on the normalised session.
 */
import type { JsonlRecord } from "../../exec.js";
import {
  addClaim,
  asString,
  asStringArray,
  isObject,
  newAccumulator,
  noteIdentity,
  noteUnknown,
  type Accumulator,
} from "../normalize.js";
import type { ClaimedChange } from "../../../types.js";

/**
 * Events we understand and deliberately take no action on.
 *
 * Listed explicitly rather than ignored by default, so that a genuinely new
 * event kind shows up in `unknown_events` instead of being silently swallowed.
 */
const KNOWN_INERT = new Set([
  "user_prompt",
  "agent_response",
  "tool_call",
  "tool_result",
  "file_read",
  "usage",
]);

/** `change` values the format uses, mapped onto our three kinds. */
function claimKind(change: unknown): ClaimedChange["kind"] {
  const c = asString(change)?.toLowerCase();
  if (c === "created" || c === "added" || c === "new") return "created";
  if (c === "deleted" || c === "removed") return "deleted";
  return "modified";
}

export function readAcmeEvents(records: JsonlRecord[]): Accumulator {
  const acc = newAccumulator();

  for (const record of records) {
    if (!isObject(record.value)) {
      noteUnknown(acc, "non-object record", record.line);
      continue;
    }
    const o = record.value;
    const event = asString(o["event"]);
    if (!event) {
      noteUnknown(acc, "record without an event name", record.line);
      continue;
    }

    noteIdentity(acc, "session_id", o["session_id"]);

    switch (event) {
      case "session_started": {
        acc.lifecycle.started = true;
        const agent = o["agent"];
        if (isObject(agent)) {
          const name = asString(agent["name"]);
          const version = asString(agent["version"]);
          noteIdentity(acc, "agent", name && version ? `${name} ${version}` : name);
        }
        noteIdentity(acc, "repo", o["repository"]);
        break;
      }

      case "session_ended": {
        acc.lifecycle.ended = true;
        acc.lifecycle.status = asString(o["status"]);
        break;
      }

      case "file_changed": {
        const path = asString(o["path"]) ?? asString(o["file_path"]);
        if (!path) {
          noteUnknown(acc, "file_changed without a path", record.line);
          break;
        }
        addClaim(acc, path, claimKind(o["change"]), record.line, asString(o["summary"]));
        break;
      }

      case "checkpoint_created": {
        const id = asString(o["checkpoint_id"]);
        if (!id) {
          noteUnknown(acc, "checkpoint_created without a checkpoint_id", record.line);
          break;
        }
        acc.checkpoints.push({
          checkpoint_id: id,
          line: record.line,
          open_questions: asStringArray(o["open_questions"]),
          ...(asString(o["git_commit"]) ? { git_commit: asString(o["git_commit"])! } : {}),
          ...(asString(o["intent"]) ? { intent: asString(o["intent"])! } : {}),
          ...(asString(o["summary"]) ? { summary: asString(o["summary"])! } : {}),
        });
        break;
      }

      default: {
        if (!KNOWN_INERT.has(event)) noteUnknown(acc, event, record.line);
        break;
      }
    }
  }

  return acc;
}
