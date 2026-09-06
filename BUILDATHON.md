# entire-guard

## One-sentence summary

An MCP server that hands a coding agent a **change contract** derived from Entire Graph impact
analysis plus Entire Checkpoint history, then **holds the agent to that contract** by
adjudicating what it actually edited.

## Problem, intended user and why it matters

**User:** a developer supervising a coding agent on an unfamiliar codebase.

An agent asked to change a function does two things wrong. It edits files **outside** the blast
radius — "helpful" unrelated refactors. And, more dangerously, it **misses callers inside** the
blast radius that it was obliged to update.

The reviewer sees only a diff. A diff shows what changed. It **structurally cannot** show what
*should* have changed and didn't, because the evidence for a forgotten caller is an **absence** —
there is no line to look at. Meanwhile the context that would have warned you (this approach was
tried before and deadlocked; rate limiting was deliberately deferred) sits in checkpoints the
agent never reads.

**Why it matters: the failure is silent.** The agent reports success. CI reports success. The
missing caller surfaces in production.

## Selected Entire track and why Entire is essential

**Track 3 — Bring Entire to a New Agent or Workflow.** A protocol adapter between Entire and any
MCP-capable coding agent.

The track explicitly disqualifies *"calling an Entire command from another interface."* We do not
rebuild `entire why`, `entire graph impact` or `entire checkpoint explain`; all three are consumed
as evidence inputs. The defence is structural:

> **No Entire command can do what entire-guard does, because no Entire command holds state
> between a proposal and a verification.**

`propose_change` writes a durable contract. `verify_change` adjudicates a later, **separate**
action against that earlier commitment. The value lives in the *interval between two calls* — a
place a stateless CLI cannot reach. The contract, the adjudication and the verdict are ours.

Both Entire surfaces are load-bearing, not decorative:

- **Entire Graph** produces the blast radius. Without it there is no contract to hold anyone to.
- **Entire Checkpoints** produce `known_traps` — unresolved work and prior failures recalled from
  history. Without them the agent walks into decisions someone already made and rejected.

Neither alone produces the verdict.

**Direction of travel.** This repository teaches **Entire about agents** — capture, transcripts,
checkpoints. entire-guard is the inverse: it teaches **agents about Entire**, delivering impact
radius and checkpoint history over MCP as a governance layer. Same seam, opposite direction.

## Architecture and main workflow

```
MCP client (Claude Code / Cursor / any MCP agent)
        |  stdio, JSON-RPC
+-------v------------------------------------------+
|  entire-guard MCP server (TypeScript, Node 22)   |
|  tools:  propose_change . verify_change          |
|                                                  |
|  +------------+  +-----------+  +-------------+  |
|  | Contract   |  | Adjudi-   |  | Evidence    |  |
|  | store      |  | cator     |  | providers   |  |
|  | (on disk)  |  | (pure fn) |  | (adapters)  |  |
|  +------------+  +-----------+  +------+------+  |
+------------------------------------------|-------+
                                           | child_process
       +-----------------------------------+---------------+
       v                          v                        v
entire graph impact       entire checkpoint            git diff
entire graph diff           list / explain             --name-only
```

**`propose_change({ symbol, depth?, allow_dirty? })`** — refuses on a dirty tree (a contract
against an already-modified tree adjudicates nothing), pins `base_sha`, then builds:

| Field | Meaning | Confidence | Verdict weight |
|---|---|---|---|
| `must_update` | depth-1 callers in *other* files | deterministic (`CALLS`) | **FAIL** if untouched |
| `allowed_files` | the proven blast radius | deterministic | **FAIL** if edited outside |
| `drift_candidates` | co-change history (`FILE_CHANGES_WITH`) | **heuristic** | WARN only |
| `known_traps` | unresolved work from checkpoints | **heuristic** | WARN only |
| `degraded` | what could **not** be determined | — | always disclosed |

The contract is written to `.entire-guard/contracts/<id>.json` — on disk deliberately, so it
survives a server restart, survives a fresh agent session, and can be opened by a human.

**`verify_change({ contract_id? })`** — loads the contract, diffs the working tree against
`base_sha`, runs `entire graph diff` for entity-level semantic changes, and adjudicates:

- `out_of_bounds` = edited − allowed → **FAIL**
- `forgotten` = obliged − edited → **FAIL** ← *the finding a diff cannot show*
- drift and traps → **WARN** (heuristic, never a sole cause of failure)

**Every finding prints the literal command that produced it.** Copy any line out of the output
and re-run it.

### Design rules the code enforces

1. **Degrade loudly, never fabricate.** If the radius cannot be measured, no contract is written.
2. **A heuristic relation never causes a FAIL.** `FILE_CHANGES_WITH` and `TESTS` are heuristic per
   the graph's own capabilities output; they warn, and the output says so.
3. **The adjudicator is a pure function** — no I/O, no clock, no model. Same inputs, same verdict.
4. **Policy is one object**, so a new constraint is a config change, not a rewrite.
5. **stdout is sacred** — MCP speaks JSON-RPC over it; diagnostics go to stderr.

## Entire Graph findings and verification

Full detail and reproduction commands: [`evidence/README.md`](evidence/README.md).

1. **Search** (`evidence/01-search.json`) — located the adjudication logic from a plain-language
   description.
2. **Impact before a high-risk change** (`evidence/02-impact.json`) — run against our **own**
   `adjudicate`, the highest-risk symbol in the project since every verdict flows through it.
   Found 6 callers: 4 at depth 1, 2 transitively at depth 2.
3. **Final semantic diff** (`evidence/03-semantic-diff.json`) — entity-level change set from the
   pre-freeze commit to HEAD. `verify_change` runs this same command on every verdict, so the
   required artifact *is* a product feature.

**Verified against source.** The graph claimed `verify` in `core.ts` calls `adjudicate` at line
110. `grep -n` confirms `adjudicate(` at line 110. Lines 34 and 39 also contain the word but are
prose in comments — the graph correctly did not report them, which is exactly the difference
between structural analysis and text search.

**A bug this discipline caught in our own code.** `known_traps` silently returned empty on every
run. The adapter looked for `id`/`sha` as the checkpoint identifier; the CLI emits
`checkpoint_id`. Every checkpoint was skipped while the tool reported the plausible message *"no
unresolved work found."* It survived because `checkpoints.json` was the one shape never pinned as
a fixture — the probe ran when the repo had zero checkpoints, so the field names were guessed
from the design doc instead of observed. Fixed, fixtures captured, and now proven live: `propose`
against `adjudicate` returns `KNOWN TRAPS (1)` sourced from checkpoint `2463e7d51ae5`.

That is the exact failure class this product exists to catch — code compiled, tests passed, output
looked right, feature did nothing.

## Noon Curveball: what changed and how we adapted

*The Curveball was delayed past its scheduled time; this section is completed once it is received.*

The design isolates policy (`depth`, `exclude_tests`, `fail_on`, `max_context_bytes`,
`drift_max`, `drift_min_commits`, `fail_on_degraded`) into a single object from the first commit,
specifically so a new constraint is a configuration change rather than a rewrite. Anticipated
constraint classes and the standing hedge:

| Constraint | Why we already survive it |
|---|---|
| Offline / no egress | The graph reports `features_requiring_network_access` all `false`. Trap extraction is keyword-based, not LLM. Already offline. |
| Deterministic / reproducible | No model in the critical path. Same inputs → same verdict, byte for byte. |
| No checkpoint history | The `degraded[]` path was designed in from day one and is unit-tested. |
| Fail closed / human gate | The verdict is already tri-state with an explicit FAIL; `fail_on` and `fail_on_degraded` are policy fields. |
| Must run in CI | `src/cli.ts` already exists: same core, no protocol, exit codes 0/1/2/3. |
| No cross-repo context leak | `repo_root` is pinned in the contract and a mismatch is refused. Tested. |

## Checkpoint links and what each checkpoint proves

| # | Checkpoint | Commit | What it proves |
|---|---|---|---|
| 1 | Initial understanding and intended architecture | `6ac492c` | The problem, the two-tool design, the stateful-interval argument, and the options rejected (LLM trap extraction, trusting `--max-context-bytes`, heuristic-driven FAIL) — with what would falsify the idea |
| 2 | Last stable state before the Noon Curveball | `85c1b9b` | The runnable slice, six assumptions the build invalidated, and the open risks going in |
| 3 | Response to the Noon Curveball | *pending* | — |
| 4 | Final implementation and verification | *pending* | — |

Inspect any of them:

```bash
entire checkpoint list
entire checkpoint explain <checkpoint_id> --full
```

**An honest note on Checkpoint 1.** The commits originally intended to carry it (`3ba6684`,
`c28e6bf`) were made outside an Entire session, so no `Entire-Checkpoint` trailer was minted and
no checkpoint existed. An audit caught this. It was re-recorded at `6ac492c` with the full
original reasoning, and **deliberately not backdated** — rewriting history would have faked a
timestamp and changed every SHA, detaching the checkpoints that did exist.

## Setup, run and test instructions

Requires Node 22+, the Entire CLI, and the graph plugin (`entire plugin install graph`).

```bash
cd mcp/entire-guard
npm install
npm run build
npm test          # 33 tests
```

Register with any MCP client. A project-level `.mcp.json` exists at the repository root:

```json
{ "mcpServers": { "entire-guard": { "command": "node", "args": ["./mcp/entire-guard/dist/server.js"] } } }
```

> `dist/` is not committed, so **`npm install && npm run build` must be run before an MCP client
> can start the server.**

### Try it without an MCP client

```bash
# from the repository root
node mcp/entire-guard/dist/cli.js propose "agents/entire-agent-kiro/internal/protocol/protocol.go:107"
# edit the definition, leave the caller alone, then:
node mcp/entire-guard/dist/cli.js verify
# -> FAIL, names the forgotten caller, exit code 2
```

Exit codes: `0` PASS, `1` WARN, `2` FAIL, `3` error — so it drops straight into a CI check.

## Known limitations and next steps

**Limitations, stated before a reviewer finds them:**

- `TESTS` and `FILE_CHANGES_WITH` are heuristic relations. Labelled as such; never the sole cause
  of a FAIL.
- Trap extraction is keyword-based, so recall is limited — an open risk phrased unusually is
  missed. Chosen deliberately over an LLM for determinism and offline operation.
- Blast radius is bounded at depth 2; a genuinely transitive break at depth 3+ is out of scope.
- **Adjudication is path-level, not hunk-level** — editing a file anywhere satisfies its
  obligation. A caller edited in the wrong place still counts as updated.
- Dynamic dispatch, reflection and codegen are invisible to a static graph.
- Drift warnings suppress repository plumbing and cap the list; every suppression is counted in
  `degraded[]`, but the ranking heuristic is ours, not the graph's.
- Single-repo only. Cross-repo impact is a next step, not a claim.
- The automated test suite does not shell out to `entire` or `git` — that seam is exercised by
  hand. The suite covers the pure logic, the parsers against real captured output, and the
  contract round trip.

**Next steps:**

1. Store the contract in git notes rather than a dotfile, so it travels with the branch.
2. A CI entrypoint posting the verdict as a PR check (the CLI already returns the right codes).
3. Hunk-level adjudication, so "edited the file" and "updated the call" stop being the same claim.
4. Learn per-repo depth and drift policy from historical `FILE_CHANGES_WITH` data.
