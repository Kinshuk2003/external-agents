/**
 * Session-transcript reader tests.
 *
 * These are the four categories the Track 3 card mandates -- original format,
 * new format, unknown events, incomplete input -- plus detection refusal.
 *
 * Every fixture is JSONL. `track-3-agent-session.jsonl` is the attached
 * Curveball fixture, byte for byte. The `session-entire-protocol.jsonl` and
 * `session-original-unknown-events.jsonl` fixtures are constructed, but each
 * record matches a real struct in this repository's external-agent protocol
 * (each agent's `internal/protocol/types.go`): `EventJSON` (numeric `type`),
 * `HookInputJSON` (`hook_type` + `tool_name` + `tool_input`) and
 * `AgentSessionJSON` (`modified_files` / `new_files` / `deleted_files`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSession } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "..", "..", "test", "fixtures");

function read(name: string): string {
  return readFileSync(path.join(fixtures, name), "utf8");
}

// ---------------------------------------------------------------------------
// NEW FORMAT -- the attached Curveball fixture
// ---------------------------------------------------------------------------

test("new format: detects acme-events and reads the session identity", () => {
  const out = parseSession(read("track-3-agent-session.jsonl"), "track-3-agent-session.jsonl");

  assert.ok(out.session, "a session was produced");
  assert.equal(out.session.format, "acme-events");
  assert.equal(out.session.session_id, "btw-track3-demo-001");
  assert.equal(out.session.agent, "AcmeCode 1.4.2");
  assert.equal(out.session.repo, "github.com/example/checkout-service");
});

test("new format: three file_changed events collapse to two distinct claimed paths", () => {
  const out = parseSession(read("track-3-agent-session.jsonl"), "fixture");

  const paths = out.session!.claimed_changes.map((c) => c.path).sort();
  assert.deepEqual(paths, ["src/checkout/apply_coupon.ts", "tests/checkout/apply_coupon.test.ts"]);
  const coupon = out.session!.claimed_changes.find((c) => c.path === "src/checkout/apply_coupon.ts")!;
  assert.equal(coupon.kind, "modified");
  assert.equal(coupon.events, 2, "the file was reported changed twice");
});

test("new format: a complete session is marked complete", () => {
  const out = parseSession(read("track-3-agent-session.jsonl"), "fixture");

  assert.equal(out.session!.lifecycle.started, true);
  assert.equal(out.session!.lifecycle.ended, true);
  assert.equal(out.session!.lifecycle.status, "completed");
  assert.equal(out.session!.complete, true);
  assert.deepEqual(out.session!.degraded, []);
});

test("new format: checkpoint_created is read into a checkpoint with its open questions", () => {
  const out = parseSession(read("track-3-agent-session.jsonl"), "fixture");

  assert.equal(out.session!.checkpoints.length, 1);
  const cp = out.session!.checkpoints[0]!;
  assert.equal(cp.checkpoint_id, "cp-001");
  assert.equal(cp.git_commit, "8d34f70c1e9fd62c1b5dc4fbbbf5013db2817ae1");
  assert.deepEqual(cp.open_questions, [
    "Should expiry or disabled state take precedence in user-facing errors?",
  ]);
});

// ---------------------------------------------------------------------------
// ORIGINAL FORMAT -- this repository's external-agent protocol
// ---------------------------------------------------------------------------

test("original format: detects entire-protocol and reads the session identity", () => {
  const out = parseSession(read("session-entire-protocol.jsonl"), "fixture");

  assert.ok(out.session);
  assert.equal(out.session.format, "entire-protocol");
  assert.equal(out.session.session_id, "kiro-77c1");
  assert.equal(out.session.agent, "kiro");
});

test("original format: claimed changes come from the AgentSessionJSON batch summary", () => {
  const out = parseSession(read("session-entire-protocol.jsonl"), "fixture");

  const byPath = new Map(out.session!.claimed_changes.map((c) => [c.path, c.kind]));
  assert.equal(byPath.get("src/checkout/apply_coupon.ts"), "modified");
  assert.equal(byPath.get("tests/checkout/apply_coupon.test.ts"), "created");
  assert.equal(byPath.get("src/promotions/legacy_coupon.ts"), "deleted");
});

test("original format: a read-only tool is not counted as a claimed change", () => {
  const out = parseSession(read("session-entire-protocol.jsonl"), "fixture");

  const paths = out.session!.claimed_changes.map((c) => c.path);
  assert.equal(
    paths.includes("src/promotions/coupon.ts"),
    false,
    "readFile touched this path but did not change it",
  );
});

test("original format: integer lifecycle events resolve start and end", () => {
  const out = parseSession(read("session-entire-protocol.jsonl"), "fixture");

  assert.equal(out.session!.lifecycle.started, true);
  assert.equal(out.session!.lifecycle.ended, true);
  assert.equal(out.session!.complete, true);
});

// ---------------------------------------------------------------------------
// UNKNOWN EVENTS -- must not crash, in either format
// ---------------------------------------------------------------------------

test("unknown events in the new format are recorded, not thrown", () => {
  const out = parseSession(read("session-unknown-events.jsonl"), "fixture");

  const names = out.session!.unknown_events.map((u) => u.name).sort();
  assert.deepEqual(names, ["mcp_tool_call", "subagent_spawned", "thinking_block"]);
});

test("unknown events in the new format do not suppress the events we do understand", () => {
  const out = parseSession(read("session-unknown-events.jsonl"), "fixture");

  assert.equal(out.session!.claimed_changes.length, 1);
  assert.equal(out.session!.claimed_changes[0]!.path, "src/checkout/apply_coupon.ts");
  assert.equal(out.session!.complete, true);
});

test("unknown integer event types in the original format are recorded, not thrown", () => {
  const out = parseSession(read("session-original-unknown-events.jsonl"), "fixture");

  const names = out.session!.unknown_events.map((u) => u.name).sort();
  assert.deepEqual(names, ["hook:pre-compact", "type:5", "type:99"]);
  assert.equal(
    out.session!.claimed_changes.some((c) => c.path === "src/checkout/apply_coupon.ts"),
    true,
    "the edit alongside the unknown events still landed",
  );
});

test("an unknown event seen twice is counted once with its first line", () => {
  const text = [
    '{"event":"session_started","session_id":"s"}',
    '{"event":"weird_thing","session_id":"s"}',
    '{"event":"weird_thing","session_id":"s"}',
  ].join("\n");

  const out = parseSession(text, "inline");

  assert.equal(out.session!.unknown_events.length, 1);
  assert.equal(out.session!.unknown_events[0]!.count, 2);
  assert.equal(out.session!.unknown_events[0]!.first_line, 2);
});

// ---------------------------------------------------------------------------
// INCOMPLETE INPUT -- a partial result, never a discarded session
// ---------------------------------------------------------------------------

test("incomplete input still produces a session rather than discarding it", () => {
  const out = parseSession(read("session-incomplete.jsonl"), "fixture");

  assert.ok(out.session, "the session survives a truncated transcript");
  assert.equal(out.session.session_id, "btw-track3-demo-002");
  assert.equal(out.session.claimed_changes.length, 1, "the intact file_changed event survives");
  assert.equal(out.session.claimed_changes[0]!.path, "src/checkout/apply_coupon.ts");
});

test("incomplete input is marked incomplete and says why", () => {
  const out = parseSession(read("session-incomplete.jsonl"), "fixture");

  assert.equal(out.session!.complete, false);
  assert.equal(out.session!.lifecycle.ended, false);
  assert.ok(
    out.session!.degraded.some((d) => d.includes("line 5")),
    `degraded should name the truncated line, got: ${JSON.stringify(out.session!.degraded)}`,
  );
});

test("a session that ends without a session_ended event is incomplete even when every line parses", () => {
  const text = [
    '{"event":"session_started","session_id":"s"}',
    '{"event":"file_changed","session_id":"s","path":"a.ts","change":"modified"}',
  ].join("\n");

  const out = parseSession(text, "inline");

  assert.equal(out.session!.complete, false);
  assert.equal(out.session!.claimed_changes.length, 1);
});

// ---------------------------------------------------------------------------
// DETECTION -- refuse rather than guess
// ---------------------------------------------------------------------------

test("an empty transcript yields no session and says so", () => {
  const out = parseSession("", "empty");

  assert.equal(out.session, undefined);
  assert.equal(out.degraded.length > 0, true);
});

test("a transcript that is not JSONL yields no session and says so", () => {
  const out = parseSession("this is a plain text log\nsecond line\n", "prose");

  assert.equal(out.session, undefined);
  assert.ok(out.degraded.join(" ").includes("could not"), out.degraded.join(" "));
});

test("a transcript carrying both discriminators is refused rather than guessed", () => {
  const text = [
    '{"event":"session_started","session_id":"s"}',
    '{"type":1,"session_id":"s"}',
  ].join("\n");

  const out = parseSession(text, "ambiguous");

  assert.equal(out.session, undefined);
  assert.ok(out.degraded.join(" ").toLowerCase().includes("ambiguous"), out.degraded.join(" "));
});

test("provenance names the transcript, so a reader can go and look at it", () => {
  const out = parseSession(read("track-3-agent-session.jsonl"), "test/fixtures/track-3-agent-session.jsonl");

  assert.equal(out.provenance.source, "transcript");
  assert.equal(out.provenance.confidence, "claimed");
  assert.ok(out.provenance.command.includes("track-3-agent-session.jsonl"));
});
