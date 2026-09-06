#!/usr/bin/env node
/**
 * CLI entrypoint over the same core as the MCP server.
 *
 * Two reasons this exists, both deliberate:
 *  1. CI. A pull-request check needs a verdict and an exit code, not a protocol.
 *  2. Fallback. If an MCP client will not connect during a demo, the product
 *     still runs. The logic is the product; MCP is the delivery.
 *
 * Exit codes: 0 = PASS, 1 = WARN, 2 = FAIL, 3 = error.
 */
import { propose, verify } from "./core.js";
import { formatContract, formatVerdict } from "./format.js";

function usage(): string {
  return [
    "entire-guard - hold a coding agent to the blast radius it was given",
    "",
    "  entire-guard propose <symbol|file:line> [--depth 1|2] [--repo PATH] [--allow-dirty]",
    "  entire-guard verify  [contract_id] [--repo PATH] [--json]",
    "",
    "Exit codes: 0 PASS, 1 WARN, 2 FAIL, 3 error.",
  ].join("\n");
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const repo = flagValue(argv, "--repo");

  if (command === "propose") {
    const symbol = argv[1];
    if (!symbol || symbol.startsWith("--")) {
      process.stderr.write("propose needs a symbol or file:line selector\n\n" + usage() + "\n");
      return 3;
    }
    const depthRaw = flagValue(argv, "--depth");
    const depth = depthRaw === "1" ? 1 : depthRaw === "2" ? 2 : undefined;
    const { contract, file } = await propose({
      symbol,
      repo,
      depth,
      allow_dirty: argv.includes("--allow-dirty"),
    });
    process.stdout.write(formatContract(contract, file) + "\n");
    return 0;
  }

  if (command === "verify") {
    const maybeId = argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined;
    const verdict = await verify({ contract_id: maybeId, repo });
    if (argv.includes("--json")) {
      process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
    } else {
      process.stdout.write(formatVerdict(verdict) + "\n");
    }
    return verdict.status === "FAIL" ? 2 : verdict.status === "WARN" ? 1 : 0;
  }

  process.stdout.write(usage() + "\n");
  return command ? 3 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    process.exit(3);
  });
