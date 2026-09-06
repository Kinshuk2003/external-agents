/**
 * The two operations, independent of any transport.
 *
 * The MCP server and the CLI entrypoint are both thin shells over this file.
 * That is deliberate: the logic is the product, MCP is one delivery mechanism,
 * and a CI check needs the same answer without a protocol in the way.
 */
import { adjudicate } from "./adjudicate/adjudicate.js";
import { buildContract, contractId } from "./contract/build.js";
import { loadContract, saveContract } from "./contract/store.js";
import { knownTraps } from "./evidence/checkpoints.js";
import { changedSince, dirtyFiles, headSha, repoRoot } from "./evidence/git.js";
import { impact, semanticDiff } from "./evidence/graph.js";
import { DEFAULT_POLICY, type ChangeContract, type Policy, type Verdict } from "./types.js";

export type ProposeArgs = {
  symbol: string;
  repo?: string;
  depth?: 1 | 2;
  /** Escape hatch for a tree that is already dirty on purpose. */
  allow_dirty?: boolean;
};

export type ProposeResult = { contract: ChangeContract; file: string };

export async function propose(args: ProposeArgs): Promise<ProposeResult> {
  const cwd = args.repo ?? process.cwd();
  const root = await repoRoot(cwd);
  const policy: Policy = { ...DEFAULT_POLICY, depth: args.depth ?? DEFAULT_POLICY.depth };

  const degraded: string[] = [];

  // Fail closed: a contract written against an already-modified tree cannot
  // adjudicate anything, because "what changed since" is already polluted.
  const dirty = await dirtyFiles(root);
  if (dirty.length > 0 && !args.allow_dirty) {
    throw new Error(
      `working tree is dirty (${dirty.length} file(s), e.g. ${dirty.slice(0, 3).join(", ")}). ` +
        "A contract proposed against a modified tree cannot adjudicate what the change did. " +
        "Commit or stash first, or re-issue with allow_dirty=true and accept that pre-existing edits will read as in-scope.",
    );
  }
  if (dirty.length > 0) {
    degraded.push(
      `working tree was already dirty at proposal time (${dirty.length} file(s)); pre-existing edits cannot be distinguished from this change`,
    );
  }

  const base = await headSha(root);

  // --head is safe here: propose runs against a clean, committed tree.
  const imp = await impact(root, args.symbol, policy, dirty.length === 0);
  degraded.push(...imp.degraded);

  // Never guess between definitions. Hand back the selector and stop.
  if (imp.data?.disambiguation_required || (imp.data?.focus_matches_total ?? 0) > 1) {
    const candidates = imp.data?.focus_candidates ?? [];
    const list = candidates
      .map((c) => `  ${c.file_path}:${c.start_line}  (${c.kind}) ${c.qualified_name ?? c.name}`)
      .join("\n");
    throw new Error(
      `"${args.symbol}" is ambiguous: ${imp.data?.focus_matches_total} definitions matched.\n` +
        list +
        "\nRe-issue propose_change with a file:line selector, for example symbol: path/to/file.go:123",
    );
  }

  if (!imp.data) {
    throw new Error(
      `could not establish a blast radius for "${args.symbol}".\n` +
        `command: ${imp.provenance.command}\n` +
        `stderr:  ${imp.raw.stderr || imp.raw.error || "(none)"}\n` +
        "No contract was written. entire-guard does not invent a radius it could not measure.",
    );
  }

  const contract = buildContract({
    id: contractId(args.symbol),
    repoRoot: root,
    baseSha: base,
    symbol: args.symbol,
    impact: imp.data,
    impactProvenance: imp.provenance,
    policy,
    degraded,
  });

  // Traps are only meaningful inside the radius we are guarding.
  const radius = new Set(contract.allowed_files.map((f) => f.path));
  const traps = await knownTraps(root, radius);
  contract.known_traps = traps.traps;
  contract.degraded.push(...traps.degraded);

  const file = await saveContract(root, contract);
  return { contract, file };
}

export type VerifyArgs = { contract_id?: string; repo?: string };

export async function verify(args: VerifyArgs): Promise<Verdict> {
  const cwd = args.repo ?? process.cwd();
  const root = await repoRoot(cwd);
  const contract = await loadContract(root, args.contract_id);

  // Never --head here: verification must see the working tree as it is now.
  const changed = await changedSince(root, contract.base_sha);
  const head = await headSha(root);
  const sem = await semanticDiff(root, contract.base_sha, "HEAD");

  return adjudicate(
    contract,
    {
      changed_files: changed.files,
      semantic_changes: sem.data,
      head_sha: head,
      degraded: sem.degraded,
      provenance: [changed.provenance, sem.provenance],
    },
    contract.policy,
  );
}
