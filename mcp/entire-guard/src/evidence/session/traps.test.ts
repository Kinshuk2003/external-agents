/**
 * Traps recalled from a transcript's own checkpoint events.
 *
 * This is the "existing Checkpoint behaviour must remain compatible" half of
 * the Track 3 card. The CLI-sourced trap path (`entire checkpoint explain`) is
 * untouched; this adds a *second source* that produces the very same KnownTrap
 * type, so nothing downstream can tell them apart except by provenance.
 *
 * Note the confidence asymmetry, which is the interesting part: the CLI path
 * has to keyword-match unresolved work out of prose, whereas the new format
 * carries `open_questions[]` as a first-class field. Structured beats scraped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSession } from "./index.js";
import { trapsFromSession } from "./traps.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "..", "..", "test", "fixtures");

function sessionFrom(name: string) {
  const text = readFileSync(path.join(fixtures, name), "utf8");
  const out = parseSession(text, name);
  assert.ok(out.session, `${name} should parse`);
  return out.session;
}

test("an open question in a transcript checkpoint becomes a known trap", () => {
  const out = trapsFromSession(sessionFrom("track-3-agent-session.jsonl"));

  assert.equal(out.traps.length, 1);
  assert.equal(
    out.traps[0]!.text,
    "Should expiry or disabled state take precedence in user-facing errors?",
  );
  assert.equal(out.traps[0]!.checkpoint_id, "cp-001");
});

test("a transcript trap carries the files the session claimed, so it can be hit later", () => {
  const out = trapsFromSession(sessionFrom("track-3-agent-session.jsonl"));

  assert.deepEqual(out.traps[0]!.files.sort(), [
    "src/checkout/apply_coupon.ts",
    "tests/checkout/apply_coupon.test.ts",
  ]);
});

test("a transcript trap is provenanced to the transcript, not to a checkpoint command", () => {
  const out = trapsFromSession(sessionFrom("track-3-agent-session.jsonl"));

  assert.equal(out.traps[0]!.provenance.source, "transcript");
  assert.equal(
    out.traps[0]!.provenance.confidence,
    "claimed",
    "the agent authored this question about its own work",
  );
});

test("a transcript with no checkpoint events yields no traps and says so", () => {
  const out = trapsFromSession(sessionFrom("session-entire-protocol.jsonl"));

  assert.deepEqual(out.traps, []);
  assert.ok(
    out.degraded.some((d) => d.includes("no checkpoint")),
    `expected a disclosure, got ${JSON.stringify(out.degraded)}`,
  );
});

test("an incomplete transcript discloses that later open questions may be missing", () => {
  const out = trapsFromSession(sessionFrom("session-incomplete.jsonl"));

  assert.deepEqual(out.traps, []);
  assert.ok(
    out.degraded.some((d) => d.toLowerCase().includes("incomplete")),
    `expected the incompleteness to be disclosed, got ${JSON.stringify(out.degraded)}`,
  );
});
