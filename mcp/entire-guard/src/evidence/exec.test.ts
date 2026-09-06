/**
 * JSONL parsing tests.
 *
 * The Curveball requires that an incomplete transcript produce a partial result
 * rather than a discarded session, so failure has to be per-line and reported,
 * never thrown. These tests pin that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJsonl } from "./exec.js";

test("parseJsonl returns each record with its 1-based source line number", () => {
  const text = ['{"event":"a"}', '{"event":"b"}'].join("\n");

  const out = parseJsonl(text);

  assert.deepEqual(
    out.records.map((r: { line: number }) => r.line),
    [1, 2],
  );
  assert.deepEqual(out.records.map((r: { value: unknown }) => (r.value as { event: string }).event), ["a", "b"]);
  assert.deepEqual(out.failures, []);
});

test("parseJsonl keeps good records when a line is truncated mid-JSON", () => {
  const text = ['{"event":"a"}', '{"event":"b"}', '{"event":"c","path":"src/'].join("\n");

  const out = parseJsonl(text);

  assert.equal(out.records.length, 2, "the two intact records survive");
  assert.equal(out.failures.length, 1, "the truncated tail is reported, not thrown");
  assert.equal(out.failures[0]!.line, 3);
});

test("parseJsonl ignores blank and whitespace-only lines without reporting failure", () => {
  const text = ['{"event":"a"}', "", "   ", '{"event":"b"}', ""].join("\n");

  const out = parseJsonl(text);

  assert.equal(out.records.length, 2);
  assert.deepEqual(out.failures, []);
});

test("parseJsonl reports a non-JSON line as a failure rather than skipping it silently", () => {
  const text = ["this is not json at all", '{"event":"a"}'].join("\n");

  const out = parseJsonl(text);

  assert.equal(out.records.length, 1);
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0]!.line, 1);
});
