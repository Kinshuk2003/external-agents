/** Git adapter: the deterministic record of what actually changed. */
import { runCommand } from "./exec.js";
import type { Provenance } from "../types.js";

export async function repoRoot(cwd: string): Promise<string> {
  const r = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  return r.ok ? r.stdout.trim() : cwd;
}

export async function headSha(cwd: string): Promise<string> {
  const r = await runCommand("git", ["rev-parse", "HEAD"], { cwd });
  if (!r.ok) throw new Error(`cannot read HEAD: ${r.error} (${r.command})`);
  return r.stdout.trim();
}

/**
 * A contract proposed against an already-modified tree adjudicates nothing,
 * so propose_change fails closed on a dirty tree. Deliberate.
 */
export async function dirtyFiles(cwd: string): Promise<string[]> {
  const r = await runCommand("git", ["status", "--porcelain"], { cwd });
  if (!r.ok) throw new Error(`cannot read git status: ${r.error} (${r.command})`);
  return r.stdout
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/** Files touched since the contract was written: committed and uncommitted. */
export async function changedSince(
  cwd: string,
  baseSha: string,
): Promise<{ files: string[]; provenance: Provenance }> {
  const tracked = await runCommand("git", ["diff", "--name-only", baseSha], { cwd });
  if (!tracked.ok) {
    throw new Error(`cannot diff against ${baseSha}: ${tracked.error} (${tracked.command})`);
  }
  const untracked = await runCommand(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd },
  );
  const files = new Set<string>();
  for (const line of tracked.stdout.split("\n")) if (line.trim()) files.add(line.trim());
  if (untracked.ok) {
    for (const line of untracked.stdout.split("\n")) if (line.trim()) files.add(line.trim());
  }
  return {
    files: [...files],
    provenance: {
      source: "git",
      command: tracked.command,
      confidence: "deterministic",
    },
  };
}
