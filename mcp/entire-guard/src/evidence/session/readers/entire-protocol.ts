/**
 * Reader for the ORIGINAL format: this repository's external-agent protocol.
 *
 * Three record shapes, taken from each agent's `internal/protocol/types.go`:
 *
 *   EventJSON        numeric `type` -- lifecycle. Observed values in this repo:
 *                    1 agent-spawn, 2 user-prompt-submit, 3 stop. `goose` also
 *                    emits 5, whose meaning is not documented here, so it is
 *                    treated as unknown rather than assumed.
 *   HookInputJSON    string `hook_type`, plus `tool_name` and `tool_input`.
 *   AgentSessionJSON `modified_files` / `new_files` / `deleted_files` -- the
 *                    authoritative **batch summary** of what the session changed.
 *
 * One deliberate restraint, and it matters: `EventJSON` carries `tool_input` but
 * **no `tool_name`**. A `file_path` on an EventJSON therefore cannot be shown to
 * be an edit rather than a read, so it is *not* counted as a claimed change.
 * Only `HookInputJSON`, which does carry `tool_name`, can contribute a
 * tool-derived claim. Over-counting claims would be the wrong kind of error: it
 * would let a path the agent merely read stand as a path the agent changed.
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

/** Integer lifecycle values observed in this repository's agents. */
const EVENT_SESSION_START = 1;
const EVENT_USER_PROMPT = 2;
const EVENT_STOP = 3;

/** Hook names declared by the agents in this repository. */
const KNOWN_HOOKS = new Set([
  "agent-spawn",
  "user-prompt-submit",
  "pre-tool-use",
  "post-tool-use",
  "stop",
  "session_start",
]);

/**
 * Does this tool name denote a write?
 *
 * Deliberately a name-shape heuristic, because every agent names its editor
 * differently (`fsWrite`, `str_replace_editor`, `edit_file`, `Write`). The
 * consequence of it missing a writer is that a claim goes uncounted -- which,
 * under the additive-only rule, can never make a verdict more permissive. The
 * consequence of it over-matching would be a false claim, so it errs narrow.
 */
function isWriteTool(name: string): boolean {
  return /(write|edit|create|append|replace|insert|patch|delete|remove|mkdir|rename|move)/i.test(
    name,
  );
}

function toolPath(input: unknown): string | undefined {
  if (!isObject(input)) return undefined;
  return (
    asString(input["path"]) ??
    asString(input["file_path"]) ??
    asString(input["filePath"]) ??
    asString(input["target_file"])
  );
}

export function readEntireProtocol(records: JsonlRecord[]): Accumulator {
  const acc = newAccumulator();

  for (const record of records) {
    if (!isObject(record.value)) {
      noteUnknown(acc, "non-object record", record.line);
      continue;
    }
    const o = record.value;
    noteIdentity(acc, "session_id", o["session_id"]);

    // --- EventJSON: numeric lifecycle type -------------------------------
    if (typeof o["type"] === "number") {
      const t = o["type"];
      if (t === EVENT_SESSION_START) acc.lifecycle.started = true;
      else if (t === EVENT_STOP) acc.lifecycle.ended = true;
      else if (t !== EVENT_USER_PROMPT) noteUnknown(acc, `type:${t}`, record.line);
      continue;
    }

    // --- HookInputJSON: named hook, possibly a tool call -----------------
    const hook = asString(o["hook_type"]);
    if (hook) {
      if (!KNOWN_HOOKS.has(hook)) {
        noteUnknown(acc, `hook:${hook}`, record.line);
        continue;
      }
      if (hook === "agent-spawn" || hook === "session_start") acc.lifecycle.started = true;
      if (hook === "stop") acc.lifecycle.ended = true;
      if (hook === "post-tool-use") {
        const tool = asString(o["tool_name"]);
        const path = toolPath(o["tool_input"]);
        if (tool && path && isWriteTool(tool)) {
          addClaim(acc, path, "modified", record.line, `${tool} reported writing this path`);
        }
      }
      continue;
    }

    // --- AgentSessionJSON: the authoritative batch summary ---------------
    const isSessionSummary =
      typeof o["agent_name"] === "string" ||
      Array.isArray(o["modified_files"]) ||
      Array.isArray(o["new_files"]) ||
      Array.isArray(o["deleted_files"]);

    if (isSessionSummary) {
      noteIdentity(acc, "agent", o["agent_name"]);
      noteIdentity(acc, "repo", o["repo_path"]);
      for (const p of asStringArray(o["modified_files"])) {
        addClaim(acc, p, "modified", record.line, "AgentSessionJSON.modified_files");
      }
      for (const p of asStringArray(o["new_files"])) {
        addClaim(acc, p, "created", record.line, "AgentSessionJSON.new_files");
      }
      for (const p of asStringArray(o["deleted_files"])) {
        addClaim(acc, p, "deleted", record.line, "AgentSessionJSON.deleted_files");
      }
      continue;
    }

    noteUnknown(acc, "unrecognised protocol record", record.line);
  }

  return acc;
}
