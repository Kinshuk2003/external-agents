# entire-guard — session handoff

Written 10:45 IST, 2026-09-06, at the point of the mandatory session restart.
Read this first, then `DESIGN.md` (§3 and §4A especially), then `BUILD-GUIDE.md`.

## Why you are a fresh session

Two reasons, both mandatory:

1. The participant guide requires a fresh agent session after `entire graph init-agents`.
2. **Checkpoints only mint from work done inside a tracked agent session in this clone.**
   The previous session ran from `c:\Users\kinsh\dev\entire-guard-planning`, so none of the
   8 installed Claude Code hooks fired. `entire session current` returned "No active session"
   and commit `3ba6684` produced **zero** checkpoints. All build work from here must happen
   with this repo as the working directory or the 15 checkpoint points are lost.

Verify before trusting: `entire session current` should now show an active session.

## State as of handoff

Done:
- Fork `Kinshuk2003/external-agents` created; mirror on `aws-ap-south-1` (India).
- Cloned via the Entire mirror workflow. `origin` = `entire://aws-ap-south-1.entire.io/gh/kinshuk2003/external-agents`.
- `entire enable --agent claude-code` — 8 hooks installed, `.entire/settings.json` written.
- `entire graph init-agents --repo .` — wrote `.entire/graph-agent.md`, updated `AGENTS.md`, `CLAUDE.md`.
- Commit `3ba6684` — docs + graph init. **No checkpoint attached** (see above).
- Four probe fixtures captured in `mcp/entire-guard/test/fixtures/`.

Not done: everything in `src/`. No implementation code exists yet.

## Probe results — real JSON, supersedes assumptions

`entire graph impact --symbol <file>:<line> --repo . --depth 2 --profile full --format json --max-context-bytes 65536`

Top-level keys:
`format_version, repo_root, commit, tree, profile, query, file, line, depth, index_cache_hit,`
`index_latency_ms, query_latency_ms, total_latency_ms, focus_matches_total, disambiguation_required,`
`focus, callers, callees, type_consumers, data_flows, co_changes, siblings, warnings,`
`partial_failures, stats, completeness, completeness_scope`

Mapping onto the data model in DESIGN.md §6:
- `callers.entries[]` where `depth == 1` and `relation == "CALLS"` -> **`must_update`** (deterministic)
- `callees`, `type_consumers`, `data_flows`, `siblings` -> **`allowed_files`** (deterministic)
- `co_changes.entries[]` (`relation: FILE_CHANGES_WITH`) -> **`allowed_files`**, marked **heuristic**
- `warnings[]` + `partial_failures[]` + `completeness_scope` -> **`degraded[]`**
- `disambiguation_required` (bool) + `focus_matches_total` -> the ambiguity path in §7 step 2

Each collection is shaped `{total, direct?, in?/out?, entries[]}`. Entries are
`{endpoint: {id, name, qualified_name, kind, file_path, start_line, end_line, language}, relation, direction, depth, call_site?}`.

`graph diff --json` -> `{base, head, files}`.
`checkpoint list --json` -> `[]` (empty until sessions exist).

## Finding that corrects the demo plan

DESIGN.md §4A hoped `graph impact` would surface the seven drifted `protocol.go` copies.
**It does not.** Measured on `HandleResolveSessionFile`:

- `callers: {total: 1, direct: 1}` — only `handlers_test.go`. The seven copies live in seven
  separate Go modules, so there are **no cross-module `CALLS` edges**. Confirmed, not assumed.
- `co_changes.total: 14`, but the entries are generic noise (`ci.yml`, `lint.yml`, `.gitignore`),
  not the sibling copies.
- `siblings.total: 0`.

The signal that *does* see them is `graph search`, whose `signals` array returned `"+6 similar"`
on that symbol. Use search, not impact, for the drift story — and label it heuristic.

**So the headline demo becomes the deterministic one:** edit `HandleResolveSessionFile` in
`agents/entire-agent-kiro/internal/protocol/protocol.go:107`, leave its direct caller
`agents/entire-agent-kiro/internal/protocol/handlers_test.go:178` untouched, and `verify_change`
returns **FAIL — forgotten: handlers_test.go (CALLS, depth 1, deterministic)**. Real, provable,
and it opens in one click. Cross-module drift stays in the deck as the WARN-tier story.

## Gotchas already paid for

- **Git Bash mangles `/gh/...` paths.** `entire repo clone /gh/owner/repo` becomes
  `C:/Program Files/Git/gh/...`. Use the full `entire://` URL, or prefix `MSYS_NO_PATHCONV=1`.
- **`-y` is not a flag on `entire enable`.** `--agent` already implies non-interactive.
- **`--max-context-bytes` defaults to 4096** and truncates silently. Always pass 65536 and
  record truncation in `degraded[]`.
- **Committed fixtures pollute the graph index.** `partial_failures` already flags
  `search.json` as `E_MINIFIED`. Harmless, but it is a live, honest `degraded[]` example.
- `entire checkpoint` is read-only — no `create`. Checkpoints mint from session work at commit time.

## Next steps, in order

1. `entire session current` — confirm a session exists. If not, stop and fix that first.
2. `npm init -y` + `@modelcontextprotocol/sdk` + `zod` + `tsx`/`typescript` in `mcp/entire-guard/`.
3. **`src/adjudicate/` — the pure function and its five unit tests. Do this before anything else.**
   Cases from DESIGN.md §9: forgotten -> FAIL; out_of_bounds -> FAIL; clean -> PASS;
   trap touched -> WARN; empty checkpoints -> PASS with `degraded` populated.
4. `src/evidence/` adapters, parsed against the captured fixtures, not live output.
5. `src/contract/` build + persist to `.entire-guard/contracts/<id>.json`.
6. `src/server/` MCP registration. **Never `console.log` — stdout is the protocol. Use `console.error`.**
7. Commit, and state the reasoning aloud in-session so the checkpoint captures it.

Freeze at 11:45. Target for the freeze is a narrow end-to-end slice, committed and
checkpointed — not a finished product. Polish belongs to the 1:00–2:30 window.
