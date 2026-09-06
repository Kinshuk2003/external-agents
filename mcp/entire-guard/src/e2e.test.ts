/**
 * End-to-end test across the real seams, using real captured graph output and
 * a real temporary filesystem.
 *
 * This is DESIGN.md section 9 layer 3, minus the CLI: it exercises
 *   real impact JSON -> buildContract -> saveContract -> loadContract
 *     -> adjudicate -> formatVerdict
 * so that contract persistence, cross-repo refusal and verdict rendering are
 * covered. Nothing else tests those.
 *
 * The one seam deliberately NOT covered here is shelling out to `entire` and
 * `git`, because that would make the suite depend on an indexed repo, a logged
 * in CLI and several seconds of graph indexing. That path is exercised by hand
 * and recorded in the build log; this keeps the suite deterministic and fast.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildContract, contractId } from "./contract/build.js";
import { loadContract, saveContract } from "./contract/store.js";
import { adjudicate } from "./adjudicate/adjudicate.js";
import { formatContract, formatVerdict } from "./format.js";
import { DEFAULT_POLICY, type Provenance } from "./types.js";
import type { ImpactResult } from "./evidence/graph.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const impact = JSON.parse(
  readFileSync(path.resolve(here, "..", "test", "fixtures", "impact.json"), "utf8"),
) as ImpactResult;

const PROV: Provenance = {
  source: "graph.impact",
  command:
    "entire graph impact --symbol agents/entire-agent-kiro/internal/protocol/protocol.go:107 --repo . --depth 2 --profile full --format json",
  confidence: "deterministic",
};

const DEFINITION = "agents/entire-agent-kiro/internal/protocol/protocol.go";
const OBLIGED_CALLER = "agents/entire-agent-kiro/internal/protocol/handlers_test.go";

async function withTempRepo<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "entire-guard-e2e-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function contractFor(root: string) {
  return buildContract({
    id: contractId("HandleResolveSessionFile"),
    repoRoot: root,
    baseSha: "aaaaaaaaaa",
    symbol: "HandleResolveSessionFile",
    impact,
    impactProvenance: PROV,
    policy: DEFAULT_POLICY,
    degraded: [],
  });
}

test("e2e: a contract survives a round trip to disk", async () => {
  await withTempRepo(async (root) => {
    const written = contractFor(root);
    const file = await saveContract(root, written);

    // It must be plain, openable JSON -- a human should be able to read what
    // the agent was held to, without our tooling.
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    assert.equal(onDisk.id, written.id);
    assert.equal(onDisk.base_sha, "aaaaaaaaaa");

    // Loading with no id must find the most recent contract.
    const loaded = await loadContract(root);
    assert.equal(loaded.id, written.id);
    assert.deepEqual(loaded.must_update, written.must_update);
  });
});

test("e2e: forgetting the obliged caller FAILS, and the verdict says why", async () => {
  await withTempRepo(async (root) => {
    await saveContract(root, contractFor(root));
    const contract = await loadContract(root);

    // The agent edits the definition and stops -- the exact silent failure.
    const verdict = adjudicate(
      contract,
      {
        changed_files: [DEFINITION],
        semantic_changes: { files: [{ path: DEFINITION, changes: [{ type: "body_changed" }] }] },
        head_sha: "bbbbbbbbbb",
        degraded: [],
        provenance: [],
      },
      { ...contract.policy, always_allowed: [] },
    );

    assert.equal(verdict.status, "FAIL");
    assert.deepEqual(verdict.forgotten.map((f) => f.path), [OBLIGED_CALLER]);

    // The rendered verdict must name the file AND carry a re-runnable command,
    // because "show where the evidence came from" is the whole point.
    const rendered = formatVerdict(verdict);
    assert.match(rendered, /VERDICT: FAIL/);
    assert.match(rendered, /handlers_test\.go/);
    assert.match(rendered, /evidence: entire graph impact/);
    assert.match(rendered, /SEMANTIC CHANGES/);
  });
});

test("e2e: updating the caller too turns the same contract into a PASS", async () => {
  await withTempRepo(async (root) => {
    await saveContract(root, contractFor(root));
    const contract = await loadContract(root);

    const verdict = adjudicate(
      contract,
      {
        changed_files: [DEFINITION, OBLIGED_CALLER],
        semantic_changes: null,
        head_sha: "bbbbbbbbbb",
        degraded: [],
        provenance: [],
      },
      { ...contract.policy, always_allowed: [] },
    );

    assert.equal(verdict.forgotten.length, 0);
    assert.equal(verdict.out_of_bounds.length, 0);
    assert.ok(verdict.in_bounds.includes(OBLIGED_CALLER));
  });
});

test("e2e: a contract from another repository is refused, not adjudicated", async () => {
  await withTempRepo(async (rootA) => {
    await withTempRepo(async (rootB) => {
      // Written for repo A...
      await saveContract(rootB, contractFor(rootA));
      // ...but loaded from repo B. Cross-repo context must not leak.
      await assert.rejects(
        () => loadContract(rootB),
        /refusing to adjudicate across repositories/,
      );
    });
  });
});

test("e2e: verify before propose gives an actionable error, not a crash", async () => {
  await withTempRepo(async (root) => {
    await assert.rejects(() => loadContract(root), /call propose_change before verify_change/);
  });
});

test("e2e: the rendered contract shows obligations, heuristic labels and evidence", async () => {
  await withTempRepo(async (root) => {
    const c = contractFor(root);
    const rendered = formatContract(c, path.join(root, "x.json"));
    assert.match(rendered, /MUST UPDATE \(1\)/);
    assert.match(rendered, /handlers_test\.go/);
    assert.match(rendered, /\[heuristic\]/);
    assert.match(rendered, /EVIDENCE - re-run any of these/);
    assert.match(rendered, /entire graph impact/);
  });
});
