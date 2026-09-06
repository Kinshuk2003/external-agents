/**
 * Contract persistence.
 *
 * On disk, not in memory, and deliberately: the contract must survive a server
 * restart, survive a fresh agent session, and be openable by a human who wants
 * to check what the agent was actually held to.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChangeContract } from "../types.js";

export function storeDir(repoRoot: string): string {
  return path.join(repoRoot, ".entire-guard", "contracts");
}

export async function saveContract(repoRoot: string, contract: ChangeContract): Promise<string> {
  const dir = storeDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${contract.id}.json`);
  await writeFile(file, JSON.stringify(contract, null, 2), "utf8");
  return file;
}

export async function loadContract(
  repoRoot: string,
  contractId?: string,
): Promise<ChangeContract> {
  const dir = storeDir(repoRoot);
  let id = contractId;
  if (!id) {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
    } catch {
      throw new Error(
        `no contracts found in ${dir} -- call propose_change before verify_change`,
      );
    }
    if (files.length === 0) {
      throw new Error(
        `no contracts found in ${dir} -- call propose_change before verify_change`,
      );
    }
    id = files[files.length - 1].replace(/\.json$/, "");
  }
  const file = path.join(dir, `${id}.json`);
  const contract = JSON.parse(await readFile(file, "utf8")) as ChangeContract;

  // Refuse to adjudicate a contract written against a different repository.
  const here = path.resolve(repoRoot);
  const there = path.resolve(contract.repo_root);
  if (here.toLowerCase() !== there.toLowerCase()) {
    throw new Error(
      `contract ${contract.id} was written for ${contract.repo_root}, but verification is running in ${repoRoot}; refusing to adjudicate across repositories`,
    );
  }
  return contract;
}
