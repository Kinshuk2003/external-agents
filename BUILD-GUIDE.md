# entire-guard — Build Guide

Keep this open all day. Companion to `DESIGN.md`.
**Hard deadline: 3:00 PM IST.**

---

## 0. Rules that will get you disqualified if ignored

- **No implementation before 9:00 AM.** Planning, research and this document are fine. Do not fork, do not scaffold, do not write code.
- **Fork only after kickoff.** Confirm with organisers *which repository* Track 3 designates. Do not guess.
- **All code must live in the clone created through the Entire mirror workflow.** Not a fresh `git clone`, not a local folder you later push.
- **No secrets** in the repo, prompts, checkpoints, screenshots or BUILDATHON.md.

---

## 1. Pre-9:00 checklist (allowed now)

- [x] Entire CLI 0.10.5 installed
- [x] Graph plugin v0.4.0 installed
- [x] Node v22.12.0
- [ ] `entire login` works — **do this now**, auth failures at 9:05 are lethal
- [ ] Assign roles: **submission owner** (checks every link, submits), **demo owner** (can explain the system regardless of who typed it)
- [ ] Decide the MCP client you will demo in (Claude Code is simplest — a project-level `.mcp.json`)
- [ ] Read `entire agent-help` once so you stop guessing flags

Skip Databricks. It is a separate 100-point rubric that requires Databricks be *essential*; bolting it on costs more on the main rubric than it gains.

---

## 2. 9:00–9:25 — Setup and the probe that de-risks everything

**Fork target confirmed: `entireio/external-agents`.** Fork via the GitHub web UI — `gh` is not installed on this machine.

```bash
# 1. Fork https://github.com/entireio/external-agents on the web UI, keep the name. Then:
entire repo mirror create
entire repo clone /gh/Kinshuk2003/external-agents   # pick the fork + India region
cd external-agents                                  # work ONLY inside this clone

# 2. Checkpoints on
entire enable --agent claude-code --agent-help-skill
entire status

# 3. Graph on
entire graph version
entire graph init-agents --repo .
```

Two corrections from the official guide's snippet. **`-y` is not a flag on `entire enable`** — `--agent` already documents "Enables non-interactive mode"; if `-y` is rejected, drop it. And `--agent-help-skill` installs the Entire agent-help skill into the session, which stops the agent guessing flags all day — free, take it.

If first-time setup **prompts to import 30 days of session history, decline.** You want a checkpoint list where your four milestones are the only things a judge sees.

Then **restart your agent session** so it picks up the graph instructions. The guide requires this.

### The 15-minute probe — do not skip this

Your design assumes JSON shapes you have not seen. Find out now, and capture fixtures while you are at it:

```bash
mkdir -p test/fixtures

entire graph search --query "main entry point" --repo . --format json --top-k 5 \
  > test/fixtures/search.json

# pick a real function name from that output, then:
entire graph impact --symbol SOME_REAL_SYMBOL --repo . --depth 2 \
  --profile full --format json > test/fixtures/impact.json

entire graph diff --base HEAD~1 --head HEAD --json > test/fixtures/diff.json
entire checkpoint list --json                     > test/fixtures/checkpoints.json

head -c 2000 test/fixtures/impact.json
```

**Read `impact.json` before writing a parser.** Field names are what they are, not what you hoped. These fixtures are also your **offline demo insurance** — if anything breaks at 2:50 PM you still have real data to show.

### How checkpoints are actually created — read this once

`entire checkpoint` is **read-only**: `list`, `explain`, `tokens`, `search`. **There is no `checkpoint create`.** Checkpoints are "persistent records of agent work tied to commits", minted by the hooks `entire enable` installs.

So every "Checkpoint N" block below is executed as **two actions**:

1. **State the reasoning out loud in the agent session.** The session transcript is what Entire captures. Reasoning you never said is reasoning no checkpoint contains.
2. **`git commit`** with a message naming the milestone. The commit is what mints the checkpoint.

Verify the mechanism once, now, before you rely on it four times:

```bash
git commit --allow-empty -m "checkpoint: entire-guard build start"
entire checkpoint list          # a checkpoint should appear
```

If nothing appears, you have found that out at 10:40 instead of 11:45. Checkpoints list **per branch** — do not do the work on a branch you later abandon.

> **Checkpoint 1 — "Initial understanding and intended architecture"**
> Record: the problem, the two-tool design, *why not a wrapper* (the stateful-interval argument), what the probe revealed about real JSON shapes, and what you deliberately rejected (LLM-based trap extraction — rejected for determinism and offline operation).

---

## 3. Build in this order

> **RECALIBRATED 10:36 IST.** The original 9:25–11:45 plan is gone; setup ran long. Remaining to the 11:45 freeze: **~69 minutes.**
>
> **11:45 is not "done" — it is "narrow end-to-end slice, committed, checkpointed."** That is exactly what the participant guide asks of the morning block ("build a narrow end-to-end slice and create your early checkpoints"). Full polish belongs to the 1:00–2:30 window after the curveball.
>
> | Window | Work |
> |---|---|
> | now → +10 min | mirror, clone, enable, graph init, probe → fixtures |
> | +10 → +35 | **adjudicator + its 5 unit tests** ← the non-negotiable half hour |
> | +35 → +55 | evidence adapters + contract store |
> | +55 → +70 | MCP server, both tools live |
> | +70 → +75 | commit + Checkpoint 2 |
>
> **If something must fall, cut Step 5 (output formatting), not the MCP server.** The MCP surface *is* the Track 3 claim; without it this is a Track 2 project submitted to the wrong track.

The order matters. Each step ends somewhere runnable.

### Step 1 (~25 min) — Evidence adapters
`src/evidence/`: one function per command. Shell out, parse JSON, normalise. Return `{ data, provenance }` where provenance carries the literal command string.
**Done when:** a scratch script prints a normalised impact result for a real symbol.

### Step 2 (~20 min) — Contract builder + store
`src/contract/`: assemble `ChangeContract`, write to `.entire-guard/contracts/<id>.json`.
**Done when:** you can `cat` a real contract file.

### Step 3 (~30 min) — Adjudicator + its tests
`src/adjudicate/`: the pure function. **Write the tests here, now, not later.** Five cases from DESIGN.md §9.
**Done when:** `npm test` is green. This is the single most valuable half-hour of your day — it is the evidence behind "important behaviors tested."

### Step 4 (~35 min) — MCP server
`src/server/`. Modern SDK shape (**verify against the version npm actually installs**):

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "entire-guard", version: "0.1.0" });

server.registerTool("propose_change",
  { title: "Propose a change",
    description: "Returns the legitimate blast radius and known traps for a symbol.",
    inputSchema: { symbol: z.string(), depth: z.number().optional() } },
  async ({ symbol, depth }) => ({ content: [{ type: "text", text: await propose(symbol, depth) }] })
);

server.registerTool("verify_change",
  { title: "Verify a change",
    description: "Adjudicates actual edits against the contract from propose_change.",
    inputSchema: { contract_id: z.string().optional() } },
  async ({ contract_id }) => ({ content: [{ type: "text", text: await verify(contract_id) }] })
);

await server.connect(new StdioServerTransport());
```

**Critical:** MCP stdio servers communicate over stdout. **Any stray `console.log` corrupts the protocol.** Log to `console.error` only.

Register it (`.mcp.json` in the repo root):

```json
{ "mcpServers": {
    "entire-guard": { "command": "node", "args": ["./dist/server.js"] } } }
```

**Done when:** your agent lists both tools and `propose_change` returns a real radius.

### Step 5 (~20 min) — Output formatting
Make the verdict readable: status line, then out-of-bounds / forgotten / traps, each with its provenance command. This is demo surface — worth the time.

> **Checkpoint 2 (11:45) — "Last stable state before the Noon Curveball"**
> Get it runnable, commit, then record: current intent, architecture as built, what is done, what is not, the open risks. **Write this for a stranger** — at 12:00 a fresh session must reconstruct the project from it. This checkpoint is worth real points twice: once on the checkpoint criterion, once on your own ability to resume.

---

## 4. 11:45–12:00 — Freeze

- Stop adding features. Get to runnable.
- `git commit` the stable version.
- Create Checkpoint 2 above.
- Close the agent session.

---

## 5. 12:00–1:00 — Curveball

1. Receive the constraint. **Start a fresh agent session.**
2. Reconstruct from checkpoints *before editing*: `entire checkpoint list` then `entire checkpoint explain <id>`. Do this visibly — it is the thing Checkpoint criterion is measuring.
3. **Run impact analysis before touching the affected area:**
   ```bash
   entire graph impact --symbol <thing-the-curveball-affects> --repo . \
     --depth 2 --profile full --format json
   ```
   Doing this on your *own* product is a nice moment: you are using the tool's own methodology on itself.
4. Implement the **smallest complete response**. Not the most impressive one.
5. Test the changed behavior. Add a test that fails without the change.

> **Checkpoint 3 — "Response to the Noon Curveball"**
> Record: the constraint, which assumption from Checkpoint 1 it invalidated, the impact analysis you ran, options considered and rejected, what you changed, and the test that proves it.

Most likely constraints and your prepared answer (DESIGN.md §10): offline / deterministic / no-checkpoints / fail-closed / CI. You are hedged on all five. **Say the hedge out loud in the checkpoint** — "we anticipated this class of constraint and isolated policy from logic at commit 1" is a strong sentence for judges.

---

## 6. 1:00–2:30 — Finish

- Implement the constraint fully; do not leave it half-done to add features.
- Run the required graph evidence and **save the output into the repo** (`evidence/`):
  ```bash
  entire graph search --query "change contract adjudication" --repo . --format json > evidence/01-search.json
  entire graph impact --symbol adjudicate --repo . --depth 2 --profile full --format json > evidence/02-impact.json
  entire graph diff --base <pre-noon-sha> --head HEAD --json > evidence/03-semantic-diff.json
  ```
  That is all three required artifacts: search/definition lookup, impact before a high-risk change, final semantic diff.
- **Verify graph findings against source.** Open a file the graph named and confirm it. The rubric says findings must be "verified against source and tests" — do it, and say you did.
- Write `BUILDATHON.md` (skeleton below).

> **Checkpoint 4 — "Final implementation and verification"**
> What shipped, what is tested, what is verified against source, what remains unresolved.

---

## 7. 2:30–2:40 — Demo rehearsal (5 minutes, out loud, once)

Rehearse it once. Teams that do not, ramble.

1. **Problem, one sentence.** "When an agent changes a function, it edits things it shouldn't and misses callers it should. The diff can't show you the second one."
2. **`propose_change`.** Show the contract: allowed files, must-update callers, and a trap pulled from a real checkpoint.
3. **Let the agent do the work**, deliberately skipping one caller.
4. **`verify_change`.** FAIL. *"It forgot `handler.ts`."* **Open the file and prove it.** ← this is the moment; give it room
5. **Why Entire is essential.** The radius is graph evidence. The trap is checkpoint context. Neither alone produces that verdict.
6. **Curveball.** Constraint, what changed, the test that proves it.
7. **Limits + next step.** Heuristic `TESTS`, depth-2 bound, static-analysis blind spots, single-repo. Then: git notes, CI check.

Have `evidence/` and fixtures ready as a fallback if anything is live and fragile.

---

## 8. BUILDATHON.md skeleton

Use the guide's exact headings:

```markdown
# entire-guard
## One-sentence summary
## Problem, intended user and why it matters
## Selected Entire track and why Entire is essential
## Architecture and main workflow
## Entire Graph findings and verification
## Noon Curveball: what changed and how we adapted
## Checkpoint links and what each checkpoint proves
## Setup, run and test instructions
## Known limitations and next steps
```

Under **why Entire is essential**, use the stateful-interval argument verbatim from DESIGN.md §3. It is your strongest paragraph.

---

## 9. Final 20 minutes — 2:40 PM

- [ ] Final commit pushed; SHA matches the submission
- [ ] Runs from a clean checkout following your own written steps — **actually test this**
- [ ] All four checkpoints open and explain their milestone
- [ ] `evidence/` contains search + impact + semantic diff
- [ ] BUILDATHON.md complete, readable, no secrets
- [ ] `npm test` green
- [ ] Demo owner can run the critical path
- [ ] Fallback screenshot/recording saved locally
- [ ] Submitted **before 3:00 PM**

---

## 10. Failure playbook

| It's 1 PM and... | Do this |
|---|---|
| MCP client won't connect | Check for stray `console.log` on stdout first — it is the usual cause. Then run the server manually and pipe a JSON-RPC initialize by hand. |
| `graph impact` JSON isn't what you parsed | You have fixtures. Fix the adapter against the fixture, not against live output. |
| Graph too slow on a big repo | `--profile fast`, `--depth 1`, `--limit`, `--exclude-tests`, `--head`. Disclose the trade-off in `degraded[]`. |
| Nothing works and it's 2:30 | Demo the **adjudicator** with fixtures via a plain CLI entrypoint. The logic is the product; MCP is the delivery. A working core beats a broken integration. |
| Symbol ambiguity everywhere | Use `<file>:<line>` selectors throughout, including in the demo. |

**Rule for the last hour: no new features after 2:00 PM.** Only fixes, docs and evidence.

---

## 11. Live build log

### 11:15 IST — pre-freeze slice COMPLETE, ahead of the 11:45 deadline

Steps 1–5 of §3 are all done, not just the non-negotiable core.

| Step | Planned | Actual |
|---|---|---|
| 1 Evidence adapters | ~25 min | done |
| 2 Contract builder + store | ~20 min | done |
| 3 Adjudicator + tests | ~30 min | done — **14 tests green**, not 5 |
| 4 MCP server | ~35 min | done — handshake verified by hand |
| 5 Output formatting | ~20 min | done — provenance under every finding |
| *(unplanned)* CLI entrypoint | — | done — the CI hedge and demo fallback |

**Verification actually run (not assumed):**

```bash
npm test                                   # 14 passing, 0 failing
node dist/cli.js propose "agents/entire-agent-kiro/internal/protocol/protocol.go:63"
                                           # real contract, 15 allowed files, written to disk
printf '...initialize...tools/list...' | node dist/server.js
                                           # -> serverInfo entire-guard 0.1.0; both tools listed
```

The MCP handshake was tested by piping JSON-RPC by hand rather than trusting a client, which
also proves the §3 "no stray console.log on stdout" rule holds.

### Corrections to this guide, learned by running it

- **§2's checkpoint verification is misleading.** `entire checkpoint list` printed
  `checkpoints 0` while `entire status` printed `1 checkpoint not yet on origin`. Pending
  checkpoints are not in the default listing. **Use `entire status` to confirm the mechanism**,
  not `checkpoint list`. Following the guide literally would have sent us debugging a
  working feature at 10:55.
- **`node --test dist` does not recurse on Windows.** It treats the directory as a single
  failing test. Use `node --test "dist/**/*.test.js"` with the glob quoted.
- **Quoted heredocs in this shell collapse `\` to `\`.** Two source files were silently
  corrupted this way (a regex and a Windows-path test fixture). Anything containing backslashes
  must be written with an editor tool, not `cat <<'EOF'`.

### Remaining before the 11:45 freeze

- [x] Commit the stable version
- [x] Checkpoint 2 — last stable state before the Noon Curveball
- [ ] Close the agent session at 11:45

### Not started (post-curveball, §6 window)

- `evidence/` directory with the three required graph artifacts
- `BUILDATHON.md`
- Live rehearsal of the forgotten-caller demo moment
