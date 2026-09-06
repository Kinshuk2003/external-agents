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

### `propose_change({ symbol, depth?, repo?, allow_dirty?, session? })`

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

Pass `session` (a path to an agent transcript) and its checkpoint events contribute open
questions as additional `known_traps`. They land in the **same** `KnownTrap` shape the
`entire checkpoint explain` path produces, so nothing downstream can tell them apart except by
provenance. Note the direction of that trade: the CLI path has to keyword-match unresolved work
out of checkpoint prose, whereas a transcript carries `open_questions[]` as a declared field —
structured rather than scraped.

### `verify_change({ contract_id?, repo?, session? })`

Loads the contract, diffs the working tree against `base_sha`, runs `entire graph diff` for
entity-level semantic changes, and adjudicates:

- `out_of_bounds` = edited − allowed → **FAIL**
- `forgotten` = obliged − edited → **FAIL** ← the finding a diff cannot show
- `drift_candidates` untouched → **WARN** (heuristic)
- `known_traps` in edited files → **WARN** (heuristic)

**Every finding prints the literal command that produced it.** Copy any line out of the output
and re-run it yourself.

#### Reading the agent's own transcript

Pass `session` and the verdict is *reconciled* against what the agent says it did. Two transcript
formats are read — the Entire external-agent protocol (numeric `EventJSON.type`,
`HookInputJSON`, `AgentSessionJSON` file lists) and the newer string-tagged event envelope
(`file_changed`, `checkpoint_created`, `session_ended`). **The format is detected, never
guessed:** an absent or contradictory discriminator is refused into `degraded[]`, because a wrong
guess would report zero file changes with total confidence.

Reconciliation produces three findings neither source can produce alone:

| Field | Meaning | Confidence | Verdict weight |
|---|---|---|---|
| `out_of_bounds_by_claim` | the agent *itself reports* editing a file the contract forbids | claimed, checked against a **deterministic** radius | **FAIL** |
| `unverified_claims` | claimed in the transcript, absent from the diff | **claimed** | WARN only |
| `unclaimed_changes` | present in the diff, never mentioned in the transcript | **claimed** | WARN only |

And `evidence_basis` on every verdict — `deterministic` (no transcript), `reconciled` (both
sources), or `claimed_only` (no git evidence for the change set). **`claimed_only` can never be
PASS**; it is floored at WARN with the reason in `degraded[]`.

#### The safety rule, stated plainly

> **Session evidence is additive-only.** It may only *add* findings. It never discharges a
> `must_update` obligation, never shrinks `out_of_bounds`, and never removes anything.
>
> So `severity(git + session) >= severity(git)` — **by construction, not by test coverage.**

This matters because of one specific hazard. A truncated transcript parses *fewer* `file_changed`
events, so it yields fewer claims. If a claim could satisfy an obligation, fewer claims would mean
fewer `forgotten` findings, and **an incomplete input would silently turn a FAIL into a PASS** —
the very failure class this tool exists to catch. Additive-only makes that unrepresentable.
A property test asserts the inequality across an 84-case matrix of contracts, diffs and
transcripts rather than at a few chosen points.

Unknown events are counted into `unknown_events[]` and disclosed, never thrown — a format is
allowed to grow events we have never seen, and an unread event is a gap in what we know rather
than a licence to assume nothing happened.

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
7. **A self-reported claim can only add severity, never remove it.** An agent's transcript is
   evidence about the agent, not an observation of disk. It never discharges an obligation.
8. **Incomplete context is never presented as authoritative.** `claimed_only` cannot be PASS, and
   the constraint lives in the verdict type rather than in a caller's memory.

## Setup

```bash
cd mcp/entire-guard
npm install
npm run build
npm test          # 82 tests
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

With a transcript, in either format:

```bash
node mcp/entire-guard/dist/cli.js verify --repo . \
  --session mcp/entire-guard/test/fixtures/track-3-agent-session.jsonl        # new format
node mcp/entire-guard/dist/cli.js verify --repo . \
  --session mcp/entire-guard/test/fixtures/session-entire-protocol.jsonl      # original format
```

## Known limitations

- `TESTS` and `FILE_CHANGES_WITH` are heuristic relations. Labelled as such; never sole cause of a FAIL.
- Trap extraction is keyword-based, so recall is limited — an open risk phrased unusually is missed.
  Chosen deliberately over an LLM for determinism and offline operation.
- Blast radius is bounded at depth 2; a genuinely transitive break at depth 3+ is out of scope.
- Dynamic dispatch, reflection and codegen are invisible to a static graph.
- Adjudication is path-level, not hunk-level: editing a file anywhere satisfies its obligation.
- Single-repo only. Cross-repo impact is a next step, not a claim.

Limitations specific to transcript reading, found by building it:

- **Claimed paths are relative to the transcript's own repository.** When it does not match the
  contract's `repo_root`, every claimed path reads as outside the radius. The mismatch is detected
  and disclosed in `degraded[]` next to the findings it explains, but the paths are not remapped —
  guessing a mapping would be a fabrication.
- **`unclaimed_changes` is noisy on a real session**, because a human editing alongside an agent
  produces exactly that signal. WARN-only for this reason.
- **Edit-tool detection in the original format is a name-shape heuristic** (`fsWrite`,
  `str_replace_editor`, `edit_file`, …), because every agent names its editor differently. It errs
  narrow: missing a writer loses a claim, which under the additive-only rule can never make a
  verdict more permissive, whereas over-matching would invent one.
- **`EventJSON` carries `tool_input` but no `tool_name`**, so a `file_path` on one of those
  records cannot be shown to be an edit rather than a read. Those are deliberately not counted.
- **A `CALLS` edge onto a Markdown file can become an obligation.** `entire graph impact` matches a
  symbol name appearing in prose, so `evidence/README.md` shows up as a `must_update` row for
  `adjudicate` and therefore in `forgotten`. Pre-existing, unrelated to transcripts, and disclosed
  rather than filtered — filtering non-source obligations is a design change, not a patch.
