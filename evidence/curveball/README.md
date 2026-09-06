# Noon Curveball — graph impact evidence, captured before editing

Track 3's card requires impact analysis **before** the change, and states that graph use which
happens after implementation scores in the partial band. These six artifacts were captured in a
fresh agent session, reconstructed from Checkpoint `0b7f487b6e75`, with **no source file edited
first**. Working tree at capture time: clean at `28a5705`.

Graph results are evidence, not an oracle. Each finding below is followed by what it changed about
the plan, so the reasoning can be checked rather than taken on trust.

---

## 0. Search — locate the code the Curveball lands on — `00-search.json`

```bash
entire graph search --repo . --profile full --format json \
  --query "determine which files the agent actually changed and adjudicate them against the contract"
```

Rank 1 is `mcp/entire-guard/src/adjudicate/adjudicate.ts:39` — `adjudicate`, matched on
`path`, `body`, `symbol-name`, `signature`, `graph:callers` and `complete-symbol`. Located from a
plain-language description of the Curveball, without naming a file.

---

## 1–5. Impact on the five symbols the change could reach

```bash
entire graph impact --symbol changedSince --repo . --depth 2 --profile full --format json --max-context-bytes 65536
entire graph impact --symbol parseJson    --repo . --depth 2 --profile full --format json --max-context-bytes 65536
entire graph impact --symbol knownTraps   --repo . --depth 2 --profile full --format json --max-context-bytes 65536
entire graph impact --symbol verify       --repo . --depth 2 --profile full --format json --max-context-bytes 65536
entire graph impact --symbol adjudicate   --repo . --depth 2 --profile full --format json --max-context-bytes 65536
```

`--max-context-bytes` is raised to 65536 because the 4096 default truncates the radius **with no
error** — the exact silent-clipping failure this product exists to catch.

| # | Symbol | Focus | Callers | What it changed about the plan |
|---|---|---|---|---|
| 1 | `changedSince` | `src/evidence/git.ts:30` | 1 direct (`core.ts:100 verify`), 2 transitive (`cli.ts:31 main`, `server.ts`) | **`src/evidence/git.ts` is not modified at all.** The new evidence source is added *beside* it in `verify`, not inside it. This narrowed the change. |
| 2 | `parseJson` | `src/evidence/exec.ts:54` | 2 direct (`knownTraps`, `impact`) | Give it a **sibling** `parseJsonl()` rather than modify it, so neither existing caller is disturbed. |
| 3 | `knownTraps` | `src/evidence/checkpoints.ts:106` | 1 direct (`core.ts:26 propose`) | The trap path has a single entry point, so adding a second trap *source* stays local. |
| 4 | `verify` | `src/core.ts:100` | 2 direct (`cli.ts:31 main`, `server.ts`) | **Both** transports must gain the new optional input, or the feature is unreachable from one of them. |
| 5 | `adjudicate` | `src/adjudicate/adjudicate.ts:39` | 5 direct — **3 of them test files** (`adjudicate.test.ts`, `build.test.ts`, `e2e.test.ts`) | The decisive finding: every new field must be **additive and optional**, so all 33 pre-Curveball tests keep compiling and passing unmodified. |

### The two conclusions that mattered most

Both are *negative* results — things the graph told us **not** to touch, which is the harder half
of impact analysis to get from reading code:

1. **`git.ts` needs no change.** `changedSince` has exactly one caller. Nothing about how the
   deterministic diff is gathered has to move in order to add a second, differently-trusted source
   beside it. Had we assumed otherwise, the change would have reached into the one adapter whose
   correctness every existing verdict depends on.
2. **`parseJson` needs no change.** Two callers, both satisfied by the current behaviour. JSONL
   support is a new export, not a modified one.

### Verification against source

The graph claimed `verify` at `src/core.ts:100` is the sole direct caller of `changedSince`.
Checked directly:

```
$ grep -n "changedSince" mcp/entire-guard/src/core.ts
12:import { changedSince, dirtyFiles, headSha, repoRoot } from "./evidence/git.js";
106:  const changed = await changedSince(root, contract.base_sha);
```

Line 106 sits inside `verify` (lines 100–121). The claim is exact — file, function and line all
match, and the import on line 12 is correctly not reported as a call site.

The `adjudicate` run reports `evidence/README.md` among its callers, at depth 1. That is a
**documentation** file, not code: the graph matched the symbol name in prose. It is listed here
rather than quietly dropped, because it is a concrete example of why graph output is checked
against source before it is acted on.

### Limits of these results, stated rather than hidden

- Depth is bounded at 2. A genuinely transitive break at depth 3+ is outside these artifacts.
- Static analysis cannot see dynamic dispatch, reflection or codegen. Nothing here rules out a
  caller reached one of those ways.
- **`co_changes: 0` and `siblings: 0` on all five symbols.** No heuristic relation contributed
  anything here, so the narrowing above rests entirely on deterministic `CALLS` / `ASYNC_CALLS`
  edges. That is a stronger basis than usual, and it is only knowable by looking — which is why
  the raw JSON is committed alongside this summary.
- `data_flows` is non-empty (1–4 entries per symbol) and was deliberately **not** used to justify
  any part of the change.

---

---

## Live verification, after implementation

The impact analysis above ran before any edit. This section records what the implementation it
produced actually does, so the two can be compared.

```bash
cd mcp/entire-guard && npm install && npm run build && npm test
# -> 82 passing, 0 failing   (33 pre-Curveball tests unchanged, 49 new)
```

Every fixture through the real CLI, from the repository root:

```bash
node mcp/entire-guard/dist/cli.js propose adjudicate --repo . --allow-dirty \
  --session mcp/entire-guard/test/fixtures/track-3-agent-session.jsonl

for f in track-3-agent-session session-entire-protocol \
         session-original-unknown-events session-unknown-events session-incomplete; do
  node mcp/entire-guard/dist/cli.js verify --repo . \
    --session mcp/entire-guard/test/fixtures/$f.jsonl --json
done
```

| Fixture | Format detected | `evidence_basis` | Disclosed in `degraded[]` |
|---|---|---|---|
| `track-3-agent-session.jsonl` (attached) | `acme-events` | `reconciled` | repository mismatch against this checkout |
| `session-entire-protocol.jsonl` | `entire-protocol` | `reconciled` | repository mismatch |
| `session-original-unknown-events.jsonl` | `entire-protocol` | `reconciled` | `type:5 x1 (line 2)`, `type:99 x1 (line 3)`, `hook:pre-compact x1 (line 4)` |
| `session-unknown-events.jsonl` | `acme-events` | `reconciled` | `thinking_block`, `mcp_tool_call`, `subagent_spawned` |
| `session-incomplete.jsonl` | `acme-events` | `reconciled` | `line 5 could not be parsed (Unterminated string in JSON...)`; no session-end event |

Five transcripts, two formats, one adjudicator. Unknown events named rather than swallowed; the
truncated line named rather than silently shortening the session.

### The safety invariant, executed rather than asserted

Two runs against a contract whose `base_sha` is deliberately not a commit in this repository:

```
$ node mcp/entire-guard/dist/cli.js verify ct-claimonly-demo --repo .
cannot diff against deadbeef...: fatal: bad object deadbeef...
$ echo $?
3
```

Unchanged behaviour: with no second source there is nothing to fall back on, so the original
failure stands. Now with the transcript:

```
VERDICT: WARN - contract honoured, but with unverified risk
EVIDENCE BASIS: claimed_only - no git evidence for this change set, so nothing could be
                confirmed against disk. This CANNOT BE A PASS.

UNVERIFIED CLAIMS (2) - claimed in the transcript, absent from the diff. [CLAIMED]
  - src/checkout/apply_coupon.ts
    claimed modified at transcript line 7, but the diff against deadbeef... does not show it
```

That is the case the Curveball is really about — a transcript describing work this machine cannot
see in git — and the verdict is **WARN, never PASS**, with the reason stated in the output.

Monotonicity on the real repository, which is the claim that matters:

```
$ node mcp/entire-guard/dist/cli.js verify --repo .                     ; echo $?   # 2  (FAIL)
$ node mcp/entire-guard/dist/cli.js verify --repo . --session <any>     ; echo $?   # 2  (FAIL)
```

Never lower. The 84-case property test in `src/adjudicate/claims.test.ts` asserts the same
inequality across a matrix of contracts, diffs and transcripts.

### MCP surface

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node mcp/entire-guard/dist/server.js
```

`initialize` returns `entire-guard 0.1.0`; `tools/list` returns both tools, each now exposing
`session`. No stdout pollution — the JSON-RPC stream stays clean.

### One graph claim worth reporting honestly

The `adjudicate` impact run listed `evidence/README.md` as a depth-1 caller, because the graph
matched the symbol name in prose. That row is real in the contract too: it appears as a
`must_update` obligation and therefore in `forgotten`. It is pre-existing, unrelated to
transcripts, and left disclosed rather than filtered — filtering non-source obligations changes
what a FAIL means, which is a design decision and not a patch to slip into a Curveball response.
It is also the cleanest available demonstration of why this repository treats graph output as
evidence to be checked rather than as an oracle.

---

## What this evidence was used for

The revised design it produced — the invalidated assumption, the two transcript formats pinned
against real code, the additive-only safety invariant, and the test matrix — is recorded in the
**Noon Curveball** section of [`BUILDATHON.md`](../../BUILDATHON.md), written and checkpointed
before implementation began.
