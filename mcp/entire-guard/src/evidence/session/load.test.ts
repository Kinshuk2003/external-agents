/**
 * Reading a transcript off disk.
 *
 * The failure that matters here is the boring one: a caller passes a path that
 * does not exist. That must degrade, not throw -- a verification which git
 * evidence alone can still answer must not be taken down by a bad --session
 * argument.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSession } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "..", "..", "test", "fixtures");

test("loadSession reads a real transcript off disk", async () => {
  const out = await loadSession(path.join(fixtures, "track-3-agent-session.jsonl"));

  assert.ok(out.session);
  assert.equal(out.session.format, "acme-events");
  assert.equal(out.session.claimed_changes.length, 2);
});

test("loadSession degrades rather than throwing when the file does not exist", async () => {
  const missing = path.join(fixtures, "no-such-transcript.jsonl");

  const out = await loadSession(missing);

  assert.equal(out.session, undefined);
  assert.equal(out.degraded.length, 1);
  assert.ok(
    out.degraded[0]!.includes("git evidence alone"),
    `the caller must be told the verdict is still usable, got: ${out.degraded[0]}`,
  );
});

test("loadSession names the unreadable path in its provenance so it can be checked", async () => {
  const missing = path.join(fixtures, "no-such-transcript.jsonl");

  const out = await loadSession(missing);

  assert.ok(out.provenance.command.includes("no-such-transcript.jsonl"));
  assert.equal(out.provenance.confidence, "claimed");
});
