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

**Track 3 card — "The agent changed its format."** Written in a fresh session reconstructed from
Checkpoint `0b7f487b6e75`, with graph impact run **before** the first edit. The graph output that
shaped it — six artifacts, the reproduction commands, and the source checks — is committed under
[`evidence/curveball/`](evidence/curveball/README.md).

> **Status.** The design in this section was written and checkpointed **before** any code changed,
> as the card requires. It is now implemented and measured: `npm test` reports **82 passing, 0
> failing** (33 pre-Curveball tests unchanged, 49 new), and every claim below has been run.

### The assumption the Curveball invalidated

> **entire-guard assumed the record of what an agent changed is a single source with no format at
> all** — `git diff --name-only <base_sha>` against a local working tree.

Two assumptions inside that, both now false:

- **Singular.** The agent's own transcript is also a record, and a *different* one.
- **Format-free.** The record needs parsing, so its format can change underneath us — and has.

A third consequence the first two hide: **a transcript can describe work `git` on this machine
cannot see at all.** A verification path that only reads a local diff cannot represent that
situation, let alone judge it safely.

So the Curveball is not a request for a parser. It asks us to stop treating *"what changed"* as a
fact and start treating it as **evidence with a provenance and a confidence** — the discipline we
already applied to graph relations and checkpoint traps, and had never applied to the diff.

### How the design changed

A session-transcript evidence provider, added *beside* the git adapter rather than inside it:
format detection → two thin readers → **one** normaliser → **one** adjudicator.

| | Original — Entire external-agent protocol | New — AcmeCode 1.4.2 (attached fixture) |
|---|---|---|
| Discriminator | `type`, an **integer** (`1` spawn, `2` prompt, `3` stop; goose emits an undocumented `5`) | `event`, a **string** (10 kinds) |
| Changed files | `modified_files[] / new_files[] / deleted_files[]` — a **batch summary** | `file_changed` — a **stream**, one event per edit |
| Checkpoint | minted by Entire from the session | `checkpoint_created` with `intent`, `summary`, `open_questions[]` |

The load-bearing difference is not the discriminator but the *shape of the change report* — a set
versus a stream. That is why the seam is a normaliser and not a shared schema: a schema would have
had to pick one shape and discard information from the other. **Only detection and the two readers
are format-aware**; normalisation, reconciliation, adjudication, formatting and both transports are
shared. A third format is one reader file and one registry row.

Reconciling two sources produces three findings **neither source can produce alone**:

| Finding (new) | Weight |
|---|---|
| `out_of_bounds_by_claim` — the agent itself reports editing a file the contract forbids | **FAIL** (an admission against interest, checked against a deterministic radius) |
| `unverified_claims` — a claimed edit git cannot confirm | WARN (uncertain evidence never alone drives a FAIL) |
| `unclaimed_changes` — git shows an edit the transcript never mentions | WARN (a transcript may legitimately be partial) |

### Why the new result is safe

> **Session evidence is additive-only.** It may only *add* findings — never discharge a
> `must_update` obligation, never shrink `out_of_bounds`, never remove anything. Therefore
> **`severity(git + session) >= severity(git)`**, by construction rather than by test coverage.

The hazard this forecloses is exact. A truncated transcript parses **fewer** `file_changed`
events; fewer events means fewer detected edits. Had claims been allowed to satisfy obligations,
fewer of them would mean fewer `forgotten` findings, and **an incomplete input would silently turn
a FAIL into a PASS** — the precise failure class this product exists to catch, introduced by the
fix for it. Additive-only makes that unrepresentable. A property test asserts the inequality across an
84-case matrix of contracts, diffs and transcripts rather than at a few chosen points.

Second safety rule, enforced in the type rather than left to the caller: a verdict carries
`evidence_basis` of `deterministic`, `reconciled` or `claimed_only`, and **`claimed_only` can never
be PASS** — floored at WARN with `degraded[]` naming the reason. Incomplete context is never
presented as authoritative.

### Existing behaviour preserved

- `verify_change({ contract_id })` with no session is **behaviourally unchanged**: same status,
  same findings, same exit code, new buckets empty, `evidence_basis: "deterministic"`. The rendered
  output gains exactly one line — an `EVIDENCE BASIS` banner — so it is not byte-identical, and
  saying so would be an overclaim. No pre-existing test file was edited to accommodate it.
- **All 33 pre-Curveball tests still pass, unmodified.** That is *why* every new field is
  additive and optional: the pre-edit impact run on `adjudicate` named 5 direct callers, **3 of them test files**.
- **Checkpoint behaviour is unchanged and gains a second source.** Transcript
  `checkpoint_created.open_questions[]` normalise into the **same `KnownTrap` type** the
  `entire checkpoint explain` path already produces. This also closes a pre-Curveball open risk —
  that the `known_traps` happy path had never been exercised end to end.

### What the graph told us *not* to change

Impact ran on `changedSince`, `parseJson`, `knownTraps`, `verify` and `adjudicate` before any edit;
raw JSON is committed under `evidence/curveball/`. It narrowed the change twice:

- `changedSince` has exactly one caller (`core.ts:100 verify`), so **`src/evidence/git.ts` is not
  modified at all** — the new source goes beside it, not inside it.
- `parseJson` has two callers, so it gains a **sibling** `parseJsonl()` rather than a modification.

The blast radius is entirely within `mcp/entire-guard/src`. **No Go module is touched.**

### Tests — 33 before, 82 after

The card mandates four categories. All four are covered, and the format-plural cases are covered
in **both** formats rather than only the new one.

| Layer | Fixture | Tests | What it proves |
|---|---|---|---|
| Original format | `session-entire-protocol.jsonl` | 4 | claims read from the `AgentSessionJSON` batch summary and from an edit-shaped `HookInputJSON` tool; a **`readFile` on a path is not counted as a change** |
| New format | `track-3-agent-session.jsonl` (attached, byte for byte) | 4 | 3 `file_changed` events collapse to 2 distinct paths with `events: 2`; `checkpoint_created.open_questions[]` captured |
| Unknown events | `session-unknown-events.jsonl` **and** `session-original-unknown-events.jsonl` | 4 | `thinking_block` / `mcp_tool_call` / `subagent_spawned`, and integer `type: 5` / `type: 99` / `hook:pre-compact` — recorded, never thrown, and the real edit beside them still lands |
| Incomplete input | `session-incomplete.jsonl` (final line cut mid-JSON) | 3 | the session is **not discarded**: the intact `file_changed` survives, `complete: false`, and `degraded[]` names line 5 |
| JSONL isolation | inline | 4 | per-line failure; blank lines are not failures; a non-JSON line is reported rather than skipped |
| Detection refusal | inline + empty | 4 | empty, non-JSONL, and **both discriminators present** → refused into `degraded[]`, never guessed |
| Reconciliation | inline | 11 | the three new findings, the FAIL/WARN split, and `claimed_only` never PASSing |
| Trap recall | fixtures | 5 | transcript open questions become the same `KnownTrap` type |
| Rendering | inline | 5 | `[CLAIMED]` labels, the evidence-basis banner, and a git-only verdict rendering exactly as before |
| **Safety property** | 3 contracts × 4 diffs × 7 transcripts | 1 (**84 assertions**) | **`severity(git + session) >= severity(git)`** across the whole matrix |

The two tests worth reading are `"a claimed edit does NOT discharge a must_update obligation"` and
`"a truncated transcript cannot turn a FAIL into a PASS"`. They are the executable form of the
safety argument.

### Verified by running it, not only by testing it

All four fixtures were run through the real CLI against this repository. Every format reaches the
same adjudicator:

```bash
node mcp/entire-guard/dist/cli.js propose adjudicate --repo . --allow-dirty \
  --session mcp/entire-guard/test/fixtures/track-3-agent-session.jsonl
node mcp/entire-guard/dist/cli.js verify --repo . \
  --session mcp/entire-guard/test/fixtures/session-entire-protocol.jsonl
```

- **`propose` with the new-format transcript** returned `KNOWN TRAPS (1)` — *"Should expiry or
  disabled state take precedence in user-facing errors?"*, sourced from `checkpoint_created`.
  Before the Curveball this repository's own checkpoints yielded no trap for that radius, so the
  transcript path is the one that fired.
- **`verify` with each of the four fixtures** produced `EVIDENCE BASIS: reconciled`, with unknown
  event kinds and the truncated line 5 named verbatim in `DEGRADED`.
- **The `claimed_only` floor was proved live** on a contract whose `base_sha` is not a commit in
  this repository. Without a transcript, `verify` fails with git's own error and exit code 3 —
  unchanged behaviour. *With* one, it degrades to
  `EVIDENCE BASIS: claimed_only ... This CANNOT BE A PASS.`, lists both claims as
  `UNVERIFIED CLAIMS`, and returns **WARN**, not PASS. That is the "a transcript may describe work
  git cannot see" case, executed rather than asserted.
- **Monotonicity held on the real repository**: `verify` without a session exited **2**, and with
  each session also exited **2**. Never lower.
- **MCP handshake re-verified**: `initialize` → `entire-guard 0.1.0`, `tools/list` → both tools,
  each exposing `session`. No stdout pollution.

### Limitations this work exposed, stated before a reviewer finds them

- **Claimed paths are relative to the transcript's own repository.** The attached fixture is from
  `github.com/example/checkout-service`, so against a contract in *this* repo every claimed path
  reads as out-of-radius. The mismatch is detected and disclosed in `degraded[]` beside the
  findings it explains — but paths are **not** remapped, because guessing a mapping would be a
  fabrication.
- **Edit-tool detection in the original format is a name-shape heuristic**, since every agent
  names its editor differently. It errs narrow on purpose: a missed writer loses a claim, which
  under additive-only can never make a verdict more permissive, whereas over-matching would invent
  one.
- **`EventJSON` carries `tool_input` but no `tool_name`**, so a `file_path` on one of those records
  cannot be shown to be an edit rather than a read. Deliberately not counted.
- **`unclaimed_changes` is noisy on a live session** — a human editing alongside an agent produces
  exactly that signal. WARN-only for that reason.
- **A `CALLS` edge onto a Markdown file can become an obligation.** `entire graph impact` matched
  `adjudicate` in the prose of `evidence/README.md`, so it appears as a `must_update` row and hence
  in `forgotten`. Pre-existing, unrelated to transcripts, and disclosed rather than quietly
  filtered — filtering non-source obligations is a design change, not a patch.

### The hedges we had, and the one class they missed

Stated plainly, because the pre-Curveball hedge table is a matter of record. Policy was isolated
into a single object from the first commit so that a new *constraint* would be a config change,
and six constraint classes were anticipated: offline operation, determinism, absent checkpoint
history, fail-closed, CI execution, cross-repo leakage. Every one of those still holds.

**None of them covered this.** The hedges all assumed the *inputs* were fixed and only the
*policy over them* might move. Track 3 moved an input — and specifically moved the one input never
modelled as an input at all, because `git diff` looked like ground truth rather than evidence. The
transferable lesson: parameterising policy protects against new rules, not against a source of
truth turning out to be a source of *claims*.

## Checkpoint links and what each checkpoint proves

Link and inspect these by **checkpoint ID**, not by title. Entire titles a checkpoint from
whichever user prompt was active when the commit landed, so several of ours read as file
attachments rather than as descriptions. The substance is in the commit bodies, which
`explain --full` prints.

| # | Checkpoint ID | Commit | What it proves |
|---|---|---|---|
| 1 | `362b7ddbefdc` | `6ac492c` | Initial understanding and intended architecture: the problem, the two-tool design, the stateful-interval argument, and the options rejected (LLM trap extraction, trusting `--max-context-bytes`, heuristic-driven FAIL) — with what would falsify the idea |
| 2 | `2463e7d51ae5` | `85c1b9b` | The runnable end-to-end slice at the pre-noon freeze, plus six assumptions the build invalidated |
| 3 | `0b7f487b6e75` | `28a5705` | **The stable state entering the Curveball** — the checkpoint the fresh session reconstructed from, carrying the open risks going in |
| 4 | `5ce69064166d` | `b517beb` | **The Curveball response**: the invalidated assumption, the pre-edit graph impact and the two negative findings that narrowed the change, the additive-only safety invariant, 33 → 82 tests, and three defects corrected rather than shipped |

Reconstruct the pre-Curveball state exactly as this session did:

```bash
entire checkpoint explain 0b7f487b6e75 --full     # intent and open risks going in
entire checkpoint explain 5ce69064166d --full     # what changed after the Curveball, and why it is safe
entire checkpoint list
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
npm test          # 82 tests
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
