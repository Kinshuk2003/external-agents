# entire-guard

An MCP server that hands a coding agent a **change contract** derived from Entire Graph
impact analysis plus Entire Checkpoint history, then **holds the agent to that contract**
by adjudicating what it actually edited.

## The problem

An agent changes a function. It edits three files it shouldn't have, and misses one file it
should have. A `git diff` shows you the first mistake. It structurally **cannot** show you the
second, because the evidence for a forgotten caller is an *absence*. Both the agent and CI
report success. The missing caller surfaces in production.

## Why this is not a CLI wrapper

`entire why`, `entire graph impact` and `entire checkpoint explain` already ship, and we do not
rebuild any of them — they are consumed as evidence inputs.

> **No Entire command can do what entire-guard does, because no Entire command holds state
> between a proposal and a verification.**

`propose_change` writes a durable contract. `verify_change` adjudicates a later, separate
action against that earlier commitment. The value lives in the *interval between two calls* —
a place a stateless CLI cannot reach. The contract, the adjudication and the verdict are ours.

## The two tools

### `propose_change({ symbol, depth?, repo?, allow_dirty? })`

Refuses on a dirty tree (a contract against an already-modified tree adjudicates nothing),
pins `base_sha`, then runs graph impact and checkpoint recall to produce:

| Field | Meaning | Confidence | Verdict weight |
|---|---|---|---|
| `must_update` | depth-1 callers in *other* files | deterministic (`CALLS`) | **FAIL** if untouched |
| `allowed_files` | the proven blast radius | deterministic | **FAIL** if you edit outside it |
| `drift_candidates` | co-change history (`FILE_CHANGES_WITH`) | **heuristic** | WARN only |
| `known_traps` | unresolved work recalled from checkpoints | **heuristic** | WARN only |
| `degraded` | what could **not** be determined, and why | — | disclosed, never hidden |

The contract is written to `.entire-guard/contracts/<id>.json` — on disk deliberately, so it
survives a server restart, survives a fresh agent session, and can be opened by a human.

### `verify_change({ contract_id?, repo? })`

Loads the contract, diffs the working tree against `base_sha`, runs `entire graph diff` for
entity-level semantic changes, and adjudicates:

- `out_of_bounds` = edited − allowed → **FAIL**
- `forgotten` = obliged − edited → **FAIL** ← the finding a diff cannot show
- `drift_candidates` untouched → **WARN** (heuristic)
- `known_traps` in edited files → **WARN** (heuristic)

**Every finding prints the literal command that produced it.** Copy any line out of the output
and re-run it yourself.

## Design rules this code actually enforces

1. **Degrade loudly, never fabricate.** If the radius could not be measured, no contract is
   written — we do not invent one. Everything uncertain lands in `degraded[]`.
2. **A heuristic relation never causes a FAIL.** `FILE_CHANGES_WITH` and `TESTS` are labelled
   heuristic by the graph itself; they warn, and the output says so.
3. **The adjudicator is a pure function.** No I/O, no clock, no network, no model. Same inputs
   produce the same verdict byte for byte, and it is unit-testable with zero CLI dependency.
4. **Policy is one object** (`DEFAULT_POLICY` in `src/types.ts`), not thresholds scattered
   through the code — so a new constraint is a config change, not a rewrite.
5. **stdout is sacred.** MCP stdio speaks JSON-RPC over stdout; every diagnostic goes to stderr.
6. **`--max-context-bytes` is raised to 65536 and truncation is detected.** The 4096 default
   silently clips the blast radius with no error, which would corrupt the exact claim this
   product rests on.

## Setup

```bash
cd mcp/entire-guard
npm install
npm run build
npm test          # 14 tests
```

Register with any MCP client. A project-level `.mcp.json` already exists at the repo root:

```json
{ "mcpServers": { "entire-guard": { "command": "node", "args": ["./mcp/entire-guard/dist/server.js"] } } }
```

## CLI (CI and fallback)

The same core runs without a protocol in the way — a PR check needs a verdict and an exit code,
not an MCP session:

```bash
node mcp/entire-guard/dist/cli.js propose "agents/entire-agent-kiro/internal/protocol/protocol.go:63"
node mcp/entire-guard/dist/cli.js verify --json
# exit codes: 0 PASS, 1 WARN, 2 FAIL, 3 error
```

## Known limitations

- `TESTS` and `FILE_CHANGES_WITH` are heuristic relations. Labelled as such; never sole cause of a FAIL.
- Trap extraction is keyword-based, so recall is limited — an open risk phrased unusually is missed.
  Chosen deliberately over an LLM for determinism and offline operation.
- Blast radius is bounded at depth 2; a genuinely transitive break at depth 3+ is out of scope.
- Dynamic dispatch, reflection and codegen are invisible to a static graph.
- Adjudication is path-level, not hunk-level: editing a file anywhere satisfies its obligation.
- Single-repo only. Cross-repo impact is a next step, not a claim.
