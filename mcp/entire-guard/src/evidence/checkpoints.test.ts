/**
 * Checkpoint-adapter parse tests, pinned against REAL captured CLI output.
 *
 * These exist because of a bug they would have prevented. The adapter looked
 * for `id` / `sha` as the checkpoint identifier; the CLI emits `checkpoint_id`.
 * Every checkpoint was therefore skipped, and the feature returned "no
 * unresolved work found" -- a plausible, entirely wrong answer, with no error.
 *
 * It survived because this was the one CLI shape never captured as a fixture:
 * the probe ran when the repo had zero checkpoints, so `checkpoints.json` was
 * `[]` and the field names were guessed instead of observed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  coerceList,
  filesOf,
  findTrapLine,
  idOf,
  type CheckpointExplain,
} from "./checkpoints.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "..", "test", "fixtures");
const listRaw = JSON.parse(readFileSync(path.join(fixtures, "checkpoints.json"), "utf8"));
const explainRaw = JSON.parse(
  readFileSync(path.join(fixtures, "checkpoint-explain.json"), "utf8"),
) as CheckpointExplain;

test("the real list payload is a bare array and coerces cleanly", () => {
  const list = coerceList(listRaw);
  assert.ok(list.length > 0, "fixture should contain checkpoints");
  assert.ok(Array.isArray(listRaw), "the CLI emits a top-level array");
});

test("every real checkpoint yields an id -- the regression that shipped", () => {
  const list = coerceList(listRaw);
  for (const entry of list) {
    assert.ok(
      idOf(entry),
      `no id resolved for ${JSON.stringify(entry).slice(0, 120)} -- traps would be silently skipped`,
    );
  }
  // Specifically: the field is checkpoint_id, not id and not sha.
  assert.ok(Object.hasOwn(list[0], "checkpoint_id"));
});

test("alternate id spellings still resolve, and a shapeless entry does not", () => {
  assert.equal(idOf({ checkpoint_id: "a" }), "a");
  assert.equal(idOf({ id: "b" }), "b");
  assert.equal(idOf({ sha: "c" }), "c");
  assert.equal(idOf({ message: "no id here" }), undefined);
});

test("files_touched is read from the real explain payload", () => {
  const files = filesOf(explainRaw);
  assert.ok(files.length > 0, "explain fixture should list touched files");
  // Authoritative list, not scraped from prose.
  assert.ok(files.every((f) => !f.includes("\\")), "paths must be normalised");
  assert.ok(files.includes("agents/entire-agent-kiro/internal/protocol/protocol.go"));
});

test("files_touched unions the top level with per-session lists", () => {
  const merged = filesOf({
    files_touched: ["a.ts"],
    sessions: [{ files_touched: ["b.ts", "a.ts"] }],
  });
  assert.deepEqual(merged.sort(), ["a.ts", "b.ts"]);
  assert.deepEqual(filesOf(undefined), []);
});

test("trap keywords are found in prose and markdown bullets", () => {
  assert.equal(
    findTrapLine("- rate limiting was deliberately deferred to a later pass"),
    "rate limiting was deliberately deferred to a later pass",
  );
  assert.match(findTrapLine("## Risks\nThis approach failed once before here") ?? "", /failed once before/);
  // Too short, and no keyword, are both rejected.
  assert.equal(findTrapLine("ok"), undefined);
  assert.equal(findTrapLine("Everything here is completely finished and shipped"), undefined);
});

test("list --json carries only the commit SUBJECT, which is why --full is needed", () => {
  // Verified against real output: `message` is the subject line alone. The
  // reasoning -- deferrals, rejected options, open risks -- lives in the commit
  // BODY and in the session prose, neither of which appears here. So subject
  // lines alone almost never trip a keyword, and an adapter that read only this
  // field would report "no unresolved work" on a history full of it.
  const list = coerceList(listRaw);
  const subjectsWithTraps = list.filter((c) => c.message && findTrapLine(c.message));
  assert.equal(
    subjectsWithTraps.length,
    0,
    "if this starts passing, subjects got richer and the --full call may be reconsidered",
  );
  // Which is exactly why knownTraps also shells out to `explain --full`.
  for (const c of list) assert.ok((c.message ?? "").length < 200, "subjects are short");
});
