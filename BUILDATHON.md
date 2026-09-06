# entire-guard

**Track 3 — Bring Entire to a New Agent or Workflow**

| Submission field | Value |
|---|---|
| GitHub fork | https://github.com/Kinshuk2003/external-agents |
| Pull request | https://github.com/Kinshuk2003/external-agents/pull/1 (branch `feat/entire-guard`) |
| Entire mirror | `entire://aws-ap-south-1.entire.io/gh/kinshuk2003/external-agents` |
| Final commit SHA | the tip of `feat/entire-guard` — `git rev-parse feat/entire-guard` |
| Checkpoints | `362b7ddbefdc` · `2463e7d51ae5` · `0b7f487b6e75` · `5ce69064166d` · final (see the checkpoint table below) |
| Databricks | not opted in |

> `main` is a protected branch on the fork, so all code is delivered on `feat/entire-guard` via
> PR #1. Entire Checkpoints sync independently on the `entire/checkpoints/v1` ref.

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

The guide requires three artifacts. All three are below with the exact command that produced
them; the raw JSON is committed under `evidence/` and `evidence/curveball/` so any of it can be
re-run and compared. **Every command here is reproducible from the repository root.**

1. **Search / definition lookup** — `evidence/01-search.json`

   ```bash
   entire graph search --query "change contract adjudication" --repo . --format json --top-k 8
   ```

   Located the adjudication logic from a plain-language description of what it does, without
   naming a file.

2. **Impact analysis before a high-risk change** — `evidence/02-impact.json`

   ```bash
   entire graph impact --symbol adjudicate --repo . --depth 2 --profile full \
     --format json --max-context-bytes 65536
   ```

   Run against **this project's own adjudicator** — the highest-risk symbol we have, since every
   verdict passes through it. Using the tool's own methodology on itself. Found `adjudicate` at
   `mcp/entire-guard/src/adjudicate/adjudicate.ts:39` with **6 callers**: four at depth 1
   (`core.ts` plus three test files) and two at depth 2 (`cli.ts`, `server.ts`).

   `--max-context-bytes` is raised to 65536 because the 4096 default truncates the radius **with
   no error** — the exact silent-clipping failure this product exists to catch.
3. **Final semantic diff of the submitted implementation**
   (`evidence/curveball/06-semantic-diff.json`) — `entire graph diff --base 28a5705 --head HEAD`,
   re-run **after** the Curveball so it describes what is actually being submitted.
   `evidence/03-semantic-diff.json` is the earlier, pre-Curveball run and is kept for comparison
   rather than replaced.

   **28 files with entity-level changes**, and their shape is the argument: `src/types.ts` is the
   largest at 51 — all additive — while the **two format readers together are 5**. Format-aware
   code is the smallest part of the change, which is the "do not duplicate the implementation per
   format" rule measured rather than asserted. `src/evidence/git.ts` does not appear at all,
   independently confirming the prediction the pre-edit `changedSince` impact run made.

   `verify_change` runs this same command on every verdict, so the required artifact *is* a
   product feature.

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

**Track 3 card — "The agent changed its format."** Written in a fresh agent session reconstructed
from Checkpoint `0b7f487b6e75`, with graph impact run **before** the first edit.

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

### Graph impact, run before editing — and what it told us *not* to change

Captured at clean `28a5705`, **before a source file was touched**. Raw JSON in
`evidence/curveball/00-search.json` through `05-impact-adjudicate.json`.

```bash
entire graph search --repo . --profile full \
  --query "determine which files the agent actually changed and adjudicate them against the contract"

for sym in changedSince parseJson knownTraps verify adjudicate; do
  entire graph impact --symbol $sym --repo . --depth 2 --profile full \
    --format json --max-context-bytes 65536
done
```

| Symbol | Callers found | What it changed about the plan |
|---|---|---|
| `changedSince` | 1 direct (`core.ts:100 verify`), 2 transitive (`cli.ts:31 main`, `server.ts`) | **`src/evidence/git.ts` is not modified at all.** The new source is added *beside* it, not inside it |
| `parseJson` | 2 direct (`knownTraps`, `impact`) | Give it a **sibling** `parseJsonl()` rather than modify it, so neither caller is disturbed |
| `knownTraps` | 1 direct (`core.ts:26 propose`) | The trap path has a single entry point, so a second trap *source* stays local |
| `verify` | 2 direct (`cli.ts:31 main`, `server.ts`) | **Both** transports must gain the new optional input, or the feature is unreachable from one |
| `adjudicate` | 5 direct — **3 of them test files** | The decisive finding: every new field must be **additive and optional**, so all 33 pre-Curveball tests keep passing unmodified |

The two conclusions that mattered most are both *negative* results — the harder half of impact
analysis to get by reading code, and the reason this change did not sprawl.

**`co_changes: 0` and `siblings: 0` on all five symbols**, so no heuristic relation informed any of
it; the narrowing rests entirely on deterministic `CALLS` / `ASYNC_CALLS` edges. The blast radius
is entirely within `mcp/entire-guard/src`. **No Go module is touched.**

**Verified against source, not taken on trust.** The graph claimed `verify` at `core.ts:100` is the
sole direct caller of `changedSince`:

```
$ grep -n "changedSince" mcp/entire-guard/src/core.ts
12:import { changedSince, dirtyFiles, headSha, repoRoot } from "./evidence/git.js";
106:  const changed = await changedSince(root, contract.base_sha);
```

Line 106 sits inside `verify` (lines 100–121). File, function and line all match, and the import on
line 12 is correctly *not* reported as a call site.

**And one graph claim that was wrong, reported rather than hidden.** The `adjudicate` run listed
`evidence/README.md` as a depth-1 caller — the graph matched the symbol name in **prose**, not in
code. That row is real in the contract too: it appears as a `must_update` obligation and therefore
in `forgotten`. It is pre-existing, unrelated to transcripts, and left disclosed rather than
filtered, because filtering non-source obligations changes what a FAIL means. It is also the
cleanest demonstration available of why this project treats graph output as evidence to be checked
rather than as an oracle.

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
- **Clean-checkout run**: cloned fresh, `npm install && npm run build && npm test` → **82 passing,
  0 failing**. `dist/` is not committed, so the build step is required before an MCP client can
  start the server.

Observed for each fixture, all five through the same adjudicator:

| Fixture | Format detected | `evidence_basis` | Disclosed in `degraded[]` |
|---|---|---|---|
| `track-3-agent-session.jsonl` (attached) | `acme-events` | `reconciled` | repository mismatch against this checkout |
| `session-entire-protocol.jsonl` | `entire-protocol` | `reconciled` | repository mismatch |
| `session-original-unknown-events.jsonl` | `entire-protocol` | `reconciled` | `type:5 x1 (line 2)`, `type:99 x1 (line 3)`, `hook:pre-compact x1 (line 4)` |
| `session-unknown-events.jsonl` | `acme-events` | `reconciled` | `thinking_block`, `mcp_tool_call`, `subagent_spawned` |
| `session-incomplete.jsonl` | `acme-events` | `reconciled` | `line 5 could not be parsed (Unterminated string in JSON…)`; no session-end event |

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
