# entire-guard — Technical Design

**Track 3 — Bring Entire to a New Agent or Workflow**
Date: 2026-09-06 · Status: design approved, pre-implementation

---

## 1. One-sentence summary

An MCP server that hands a coding agent a **change contract** derived from Entire Graph impact analysis plus Entire Checkpoint history, then **holds the agent to that contract** by adjudicating what it actually edited.

## 2. Problem and intended user

**User:** a developer supervising a coding agent on an unfamiliar codebase.

**Problem:** agents edit outside the blast radius of the task ("helpful" unrelated refactors) and, more dangerously, *miss* callers inside the blast radius that they were obliged to update. The reviewer sees only a diff, which shows what changed but not what *should* have changed and didn't. Prior context — that this exact approach was tried before and deadlocked, that rate limiting was deliberately deferred — sits in checkpoints the agent never reads.

**Why it matters:** the failure is silent. Both the agent and CI report success. The missing caller surfaces in production.

## 3. Why this is not a CLI wrapper

This is the design's load-bearing claim, and the guide's explicit disqualifier: *"Calling an Entire command from another interface is not sufficient by itself."*

`entire why <file>:<line> --json` already ships and answers "why does this line exist." We do **not** rebuild it. The defense is structural:

> **No Entire command can do what entire-guard does, because no Entire command holds state between a proposal and a verification.**

`propose_change` writes a durable contract. `verify_change` adjudicates a later, separate action against that earlier commitment. The value lives in the *interval between two calls* — a place a stateless CLI cannot reach. Everything Entire already does well (impact, semantic diff, checkpoint recall) is consumed as **evidence inputs**; the contract, the adjudication and the verdict are ours.

Secondary, but real: the MCP surface makes this consumable by *any* MCP-capable agent as a governance layer, not a command a human has to remember to run.

## 4. Verified environment facts

Probed on this machine, 2026-09-06. Anything not listed here is an assumption.

| Fact | Value |
|---|---|
| Entire CLI | 0.10.5 (Go 1.26.6, windows/amd64) |
| Graph plugin | `entire-graph` v0.4.0, installed |
| Node / npm | v22.12.0 / 9.8.1 |
| Python | 3.12.6 |
| Missing | `gh`, `uv` |

**Commands confirmed to exist, with the flags we depend on:**

```
entire checkpoint list  [--json] [--pending] [--session ID]
entire checkpoint explain <id|sha> [--json] [--short|--full] [--transcript]
entire why <file>[:line] [--json]
entire search <query>
entire agent-help [command] [--json]        # self-describing; read it, never guess
entire api                                  # authenticated HTTP API escape hatch

entire graph impact --symbol NAME|<file>:<line> --repo . [--depth 1|2]
                    [--limit N] [--format text|json] [--exclude-tests] [--head]
entire graph diff   --base <rev> --head <rev> [--json] [--max-seconds N]
entire graph neighbors --symbol X --direction in|out|both [--depth 1|2] [--format json]
entire graph search --query "..." [--format json|agent] [--top-k N]
entire graph verify --repo .                # runs a test command, returns adjudicated verdict
entire graph capabilities --json
```

**Graph capability facts that shape the design:**

- `supported_relation_types` includes `CALLS`, `USES_TYPE`, `PARAM_TYPE`, `RETURNS_TYPE`, `READS_FIELD`, `WRITES_FIELD`, `TESTS`, `DATA_FLOWS`, `FILE_CHANGES_WITH`, `HANDLES_ROUTE`.
- `TESTS` is listed under `heuristic_relation_types` — **treat as a hint, never as a fact.** Label it as heuristic in output.
- `relation_support_by_profile`: the `full` profile is required for `DATA_FLOWS`, `TESTS`, `FILE_CHANGES_WITH`. `fast` gives only `CALLS`/`IMPORTS`/`CONTAINS`/`DEFINES`. **Use `--profile full` for impact.**
- `features_requiring_network_access`: **every value is `false`.** The graph is fully local, no egress. This is our strongest curveball hedge (§10).
- `semantic_languages` (deep relations) covers TypeScript, Python, Go, Java, Rust, C#, Ruby, PHP and ~25 more. Non-semantic languages degrade to `CONTAINS`/`DEFINES` only — detect and disclose.

**CLI corrections verified 10:20 IST — these overrule earlier assumptions:**

- `entire checkpoint` is **read-only** (`list`, `explain`, `tokens`, `search`). There is **no `checkpoint create`**. Checkpoints are "persistent records of agent work tied to commits", minted by the hooks `entire enable` installs. To author a checkpoint you **state the reasoning in the agent session** (the transcript is what gets captured) and then **`git commit`**. The commit mints it. Default backend `refs` = one git ref per checkpoint. Checkpoints list **per branch** — do not do the work on a branch you later abandon.
- `--profile full` is already the **default** on `graph impact`. Passing it is harmless and self-documenting, not a correction.
- `graph impact` also accepts `--file`, `--line`, `--kind` (the ambiguity escape hatch) and **`--max-context-bytes` (default 4096)**.
- **`--max-context-bytes` is a silent truncation budget.** On a well-connected symbol `allowed_files` / `must_update` are clipped **with no error**. That corrupts the exact claim the product rests on. Pass `--max-context-bytes 65536`, detect truncation, record it in `degraded[]`.
- `--head` ("query the committed tree, cached") suits `propose_change`, which already refuses on a dirty tree. Never use it in `verify_change`, which needs the working tree.
- `gh` is **not installed**. Fork via the GitHub web UI.

**Still unverified — capture in the probe:**

- [ ] Exact JSON shape of `entire graph impact --format json` on a real repo
- [ ] Exact JSON shape of `entire checkpoint list --json` in an enabled repo
- [ ] Whether `entire why --json` works pre-login / offline

---

## 4A. Fork target: `entireio/external-agents` (recon 10:25 IST)

Confirmed as the Track 3 repository. Reconnoitred via shallow clone before forking.

**What it is:** a Go monorepo of standalone binaries named `entire-agent-<name>` that teach the Entire CLI to capture checkpoints from coding agents it does not natively support. Seven exist: amp, goose, grok, kilo, kiro, omp, qwen. They implement a documented external-agent protocol (JSON over stdin/stdout). Build/test via `mise`, lint via `golangci`.

**Direction of the repo vs. direction of this product:**

> The repo teaches **Entire about agents** — capture, transcripts, checkpoints. entire-guard is the inverse: it teaches **agents about Entire** — impact radius and checkpoint history delivered over MCP as a governance layer. Same seam, opposite direction.

This is Track 3's "protocol adapter between Entire and another developer tool", and it is why the code lives here. Placement: `mcp/entire-guard/`, self-contained, touching neither the `mise` nor `golangci` CI.

**The load-bearing discovery — a live instance of our target defect, in our host repo:**

`internal/protocol/protocol.go` is copy-pasted across **seven independent Go modules** (each has its own `go.mod`; there is no shared package). It has **already drifted into three variants**:

| Content hash | Agents |
|---|---|
| `8e4e0b10beb5` | amp, goose, kilo |
| `8715b9e49573` | grok, kiro, qwen |
| `6eac2d17c9c4` | omp |

Nothing links the seven copies. Change one and `git diff` shows a single file; the Go compiler is silent (separate modules); CI is silent (each module builds alone). **This is precisely "what should have changed and didn't", already in its failed state, provable in front of a judge with `md5sum`.**

**Who the user is, evidenced in-repo:** `AGENTS.md`, `.claude/skills/`, `.cursor/rules/`, `.opencode/plugins/`, and a README opening "clone the repo and open it in your AI coding tool." This repo is explicitly built to be worked on by coding agents. Our intended user is the person contributing here.

### 4A.1 What the compiler already catches — state this before a judge does

In a compiled language a naively forgotten caller **inside** a module is caught by `go build`. The original TypeScript-flavoured headline ("the agent forgot `handler.ts`") is weaker here. Re-aim at the classes a compiler structurally cannot see:

| Class | Evidence | Verdict | Compiler sees it? |
|---|---|---|---|
| Cross-module drift (the 7 `protocol.go` copies) | `FILE_CHANGES_WITH` — **heuristic** | **WARN** (never FAIL on heuristic alone, §12) | No — separate modules |
| `out_of_bounds` — edited outside the allowed radius | set arithmetic over `git diff` vs. graph impact — **deterministic** | **FAIL** | No |
| Semantic change that still compiles (new protocol field one agent never populates) | `graph diff` entity-level | **FAIL** | No — builds green, breaks at runtime |
| `known_traps` — deferred work, prior failures | checkpoints | **WARN** | No |

Sharpened pitch: **the compiler catches the easy misses; entire-guard catches the three classes it structurally cannot.**

## 5. Architecture

```
MCP client (Claude Code / Cursor / any MCP agent)
        |  stdio, JSON-RPC
+-------v------------------------------------------+
|  entire-guard MCP server (TypeScript, Node 22)   |
|                                                  |
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
                            entire why
```

**Four modules, deliberately small:**

| Module | Responsibility | Depends on |
|---|---|---|
| `evidence/` | One adapter per external command. Shells out, parses JSON, normalises into our types. **The only place that knows CLI flags exist.** | child_process |
| `contract/` | Build, persist, load a `ChangeContract`. | evidence types |
| `adjudicate/` | Pure function: `(contract, actualChanges) -> Verdict`. No I/O. | types only |
| `server/` | MCP tool registration, argument validation, response formatting. | all of the above |

The adjudicator being **pure and I/O-free is the key testability decision** — it is unit-testable against fixtures with zero CLI dependency, which is what lets us honestly claim "important behaviors tested" under time pressure.

## 6. Data model

```ts
type Provenance = {
  source: "graph.impact" | "graph.diff" | "checkpoint" | "git" | "why";
  command: string;        // exact command run, for judge verification
  confidence: "deterministic" | "heuristic";
};

type ChangeContract = {
  id: string;                    // ct-<timestamp>-<shortsym>
  created_at: string;
  repo_root: string;
  base_sha: string;              // git rev-parse HEAD at proposal time
  target: { symbol: string; file: string; line?: number; kind?: string };

  allowed_files: Array<{ path: string; reason: string; provenance: Provenance }>;
  must_update:   Array<{ path: string; symbol: string; relation: string;
                         provenance: Provenance }>;   // direct callers
  known_traps:   Array<{ text: string; checkpoint_id: string;
                         provenance: Provenance }>;   // open risks / prior failures
  degraded: string[];            // what we could NOT determine, and why
};

type Verdict = {
  status: "PASS" | "WARN" | "FAIL";
  out_of_bounds: Array<{ path: string; note: string }>;   // edited, not allowed    -> FAIL
  forgotten:     Array<{ path: string; symbol: string }>; // must_update, untouched -> FAIL
  traps_hit:     Array<{ text: string; path: string }>;   // edited near a trap     -> WARN
  in_bounds:     string[];
  semantic_changes: unknown;     // entire graph diff output, verbatim
  degraded: string[];
};
```

**Every finding carries `provenance` with the literal command that produced it.** The guide demands you "show where the evidence came from" and "let the user verify it against source code." A judge can copy any command out of our output and re-run it. This is worth more rubric points than any amount of polish.

## 7. The two tool contracts

### `propose_change`

```
input:  { symbol: string, repo?: string, depth?: 1 | 2 }
```

1. `git rev-parse HEAD` -> `base_sha`. Refuse if the working tree is dirty (`git status --porcelain`) — a contract against an already-modified tree adjudicates nothing. Deliberate fail-closed.
2. `entire graph impact --symbol <s> --repo . --depth 2 --profile full --format json`
   - callers / callees / type-consumers / siblings / co-change files -> `allowed_files`
   - **direct** (depth-1) callers -> `must_update`
   - On an ambiguous symbol the CLI returns a definition list: surface it and ask the caller to re-issue with `<file>:<line>`. Do not guess.
3. `entire checkpoint list --json`, then `entire checkpoint explain <id> --json` for recent entries; keep those whose files intersect `allowed_files` and whose text signals unresolved work. **Extraction is keyword-based and deterministic** (`TODO`, `deferred`, `unresolved`, `known risk`, `failed`, `did not`, `revisit`) — no LLM. Cheap, explainable, offline, and defensible when a judge asks "how do you know that's a risk?"
4. Persist to `.entire-guard/contracts/<id>.json`. On disk, not in memory: it survives a server restart, it survives the noon session reset, and **judges can open it**.
5. Return a compact human-readable brief plus the contract id.

### `verify_change`

```
input:  { contract_id?: string }   // defaults to most recent
```

1. Load contract. `git diff --name-only <base_sha>` -> actual files touched.
2. `entire graph diff --base <base_sha> --head HEAD --json` -> entity-level semantic changes.
3. Adjudicate (pure):
   - `out_of_bounds` = actual − allowed -> **FAIL**
   - `forgotten` = must_update − actual -> **FAIL** <- *the headline finding*
   - `traps_hit` = known_traps whose file was edited -> **WARN**
4. Return the verdict, each row with its provenance command.

**Note the free win:** step 2 is a semantic diff of the submitted implementation — item three of the required Entire Graph evidence in the guide. The mandatory evidence *is* a product feature. Run it live in the demo and you satisfy the requirement and the demo in one action.

## 8. Error handling and degradation

The single most important non-functional rule: **degrade loudly, never fail silently, never fabricate.**

| Failure | Behavior |
|---|---|
| Graph plugin absent | Actionable error naming `entire plugin install graph`. No fake radius. |
| Symbol ambiguous | Return the definition list and the exact re-invocation selector. |
| No checkpoints in repo | `known_traps: []`, `degraded: ["no checkpoint history — traps not assessed"]`. Contract still valid on graph alone. |
| Not logged in / offline | Graph is no-egress, so impact still works. Checkpoint recall degrades; record it in `degraded`. |
| Language not in `semantic_languages` | Only `CONTAINS`/`DEFINES` — say so in `degraded`; never present a thin radius as complete. |
| `entire graph diff` budget exceeded | It emits partial results with `W_ANALYSIS_BUDGET_EXCEEDED`. Surface the warning verbatim. |
| Dirty tree at proposal | Refuse with explanation (fail-closed). |
| Any CLI non-zero exit | Capture stderr, return as a tool error with the exact command. Never swallow. |

The `degraded[]` array is not an afterthought — it is the mechanism by which we obey the guide's rule: *"Never present incomplete or uncertain graph output as a fact."*

## 9. Testing strategy

Three layers, in build priority order:

1. **Adjudicator unit tests (must-have).** Pure function, fixture in / verdict out. Cover: forgotten caller -> FAIL; out-of-bounds edit -> FAIL; clean change -> PASS; trap touched -> WARN; empty checkpoints -> PASS with `degraded` populated. ~5 tests, no CLI, milliseconds.
2. **Evidence-adapter parse tests (should-have).** Pin **real** captured JSON from `graph impact` / `graph diff` / `checkpoint list` into `test/fixtures/`. Capture these in the first 20 minutes — they are also your offline demo insurance.
3. **One end-to-end smoke test (nice-to-have).** Propose against a known symbol in the fork, deliberately skip a caller update, verify -> expect FAIL.

Layer 1 is non-negotiable; it backs the claim "important behaviors tested." Do it before layer 3.

## 10. Curveball hedges — built in from the start

Design choices made *now* so that noon is a config change rather than a rewrite:

| Plausible constraint | Why we already survive it |
|---|---|
| "Must work fully offline / no egress" | Graph verified `features_requiring_network_access` all `false`. Trap extraction is keyword-based, not LLM. Already offline. |
| "Must be deterministic / reproducible" | No model in the critical path. Same inputs -> same verdict, byte for byte. |
| "Must handle repos with no checkpoint history" | `degraded[]` path designed in from day one. |
| "Must fail closed / add a human gate" | Verdict is already tri-state with an explicit FAIL. Add a policy flag. |
| "Must run in CI" | Adjudicator is a pure function; wrap it in a second thin entrypoint. The server is not required for the core logic. |
| "Must not leak context across repos" | `repo_root` is pinned in the contract; refuse mismatches. |

Keep policy (`depth`, `exclude_tests`, `fail_on`) in **one config object from the first commit**. Do not scatter thresholds through the code.

## 11. Rubric mapping

| Criterion | Pts | Where we earn it |
|---|---|---|
| Problem and innovation | 20 | Forgotten-caller detection; stateful contract no CLI can express |
| Technical implementation | 25 | End-to-end MCP flow; pure adjudicator; loud degradation; fail-closed |
| Curveball response | 15 | §10 hedges; policy isolated from logic |
| Entire Checkpoints | 15 | Checkpoints are a **product input**, not just process compliance |
| Entire Graph | 15 | `impact` drives the contract; `diff` is the semantic diff evidence |
| Demonstration | 10 | Live forgotten-caller catch, verified against source on the spot |

## 12. Known limitations (state these out loud in the demo)

- `TESTS` and `FILE_CHANGES_WITH` are heuristic relations; we label them as such and never let them alone drive a FAIL.
- Trap extraction is keyword-based, so recall is limited — an open risk phrased unusually is missed. Chosen deliberately over an LLM for determinism and offline operation.
- Blast radius is bounded at depth 2; a genuinely transitive break at depth 3+ is out of scope and disclosed.
- Dynamic dispatch, reflection and codegen are invisible to a static graph. Say so before a judge says it for you.
- Single-repo only. Cross-repo impact is a next step, not a claim.

## 13. Next steps toward production

1. Store the contract in git notes rather than a dotfile, so it travels with the branch.
2. CI entrypoint posting the verdict as a PR check.
3. Learn per-repo depth policy from historical `FILE_CHANGES_WITH` data.
4. Cross-repo contracts via `entire api`.
