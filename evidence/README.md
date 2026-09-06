# Entire Graph evidence

The three required graph artifacts for this submission, captured against the submitted
implementation. Every command is reproducible from the repository root.

Graph results are evidence, not an oracle. Each finding below was **checked against source**,
and the check is written out so it can be repeated rather than taken on trust.

---

## 1. Search / definition lookup — `01-search.json`

```bash
entire graph search --query "change contract adjudication" --repo . --format json --top-k 8
```

Locates the adjudication logic from a plain-language description of what it does.

---

## 2. Impact analysis before a high-risk change — `02-impact.json`

```bash
entire graph impact --symbol adjudicate --repo . --depth 2 --profile full \
  --format json --max-context-bytes 65536
```

Run against **this project's own adjudicator** — the highest-risk symbol we have, since every
verdict the product issues passes through it. Using the tool's own methodology on itself.

**What it found:** focus `adjudicate` at `mcp/entire-guard/src/adjudicate/adjudicate.ts:39`,
with **6 callers** — four at depth 1 (`core.ts`, and the three test files) and two at depth 2
(`cli.ts`, `server.ts`).

### Verification against source

The graph claimed function `verify` in `mcp/entire-guard/src/core.ts` calls `adjudicate`,
with a call site at **line 110**. Checked directly:

```
$ grep -n "adjudicate" mcp/entire-guard/src/core.ts
8:import { adjudicate } from "./adjudicate/adjudicate.js";
110:  return adjudicate(
```

Line 110 is a call to `adjudicate`, inside `verify`. **The claim is exact — file, function and
line all match.** Lines 34 and 39 also matched the grep but are prose in comments, not calls;
the graph correctly did not report them, which is the difference between structural analysis
and text search.

### Limits of this result, stated rather than hidden

- Depth-2 callers (`cli.ts`, `server.ts`) reach `adjudicate` transitively through `verify`.
  They are in the radius, but they are not obligations.
- `--max-context-bytes` is raised to 65536 because the 4096 default silently truncates the
  radius with no error.
- Static analysis cannot see dynamic dispatch, reflection or codegen. Nothing here rules out a
  caller reached that way.

---

## 3. Final semantic diff of the submitted implementation — `03-semantic-diff.json`

```bash
entire graph diff --base 85c1b9b --head HEAD --json
```

Base `85c1b9b` is the pre-freeze stable state, so this is the entity-level change set for
everything built after it: the drift ranking, the checkpoint-id fix, and the added test layers.

This is not only a submission artifact — `verify_change` runs this same command on every
verdict, so the required evidence *is* a product feature.

---

## Reproducing all three

```bash
entire graph search --query "change contract adjudication" --repo . --format json --top-k 8 > evidence/01-search.json
entire graph impact --symbol adjudicate --repo . --depth 2 --profile full --format json --max-context-bytes 65536 > evidence/02-impact.json
entire graph diff --base 85c1b9b --head HEAD --json > evidence/03-semantic-diff.json
```

These files double as **offline demo insurance**: real captured output that can be shown if
anything live is unavailable at demo time.
