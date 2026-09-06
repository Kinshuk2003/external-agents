#!/usr/bin/env node
/**
 * entire-guard MCP server (stdio).
 *
 * CRITICAL: stdio MCP speaks JSON-RPC over stdout. A single stray console.log
 * corrupts the protocol and the client silently fails to connect. Every
 * diagnostic in this process goes to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { propose, verify } from "./core.js";
import { formatContract, formatVerdict } from "./format.js";

const server = new McpServer({ name: "entire-guard", version: "0.1.0" });

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

server.registerTool(
  "propose_change",
  {
    title: "Propose a change",
    description:
      "BEFORE editing a symbol, call this. Returns a change contract: the blast radius proved by Entire Graph impact analysis, the direct callers you are obliged to update, files that historically change alongside this one, and unresolved risks recalled from Entire Checkpoint history. Every finding carries the command that produced it.",
    inputSchema: {
      symbol: z
        .string()
        .describe("Symbol name, or a file:line selector such as internal/protocol/protocol.go:63 when the name is ambiguous."),
      repo: z
        .string()
        .optional()
        .describe("Repository root. Defaults to the server working directory."),
      depth: z
        .union([z.literal(1), z.literal(2)])
        .optional()
        .describe("Blast radius depth. Default 2."),
      allow_dirty: z
        .boolean()
        .optional()
        .describe("Proceed even if the working tree is already modified. Degrades the verdict."),
    },
  },
  async ({ symbol, repo, depth, allow_dirty }) => {
    try {
      const { contract, file } = await propose({ symbol, repo, depth, allow_dirty });
      return { content: [{ type: "text" as const, text: formatContract(contract, file) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `propose_change failed.\n\n${errorText(err)}` }],
      };
    }
  },
);

server.registerTool(
  "verify_change",
  {
    title: "Verify a change",
    description:
      "AFTER editing, call this. Adjudicates what you actually changed against the contract from propose_change: files edited outside the blast radius, and -- the finding a diff cannot show you -- proven callers that were obliged to change and did not. Includes an Entire Graph semantic diff of the result.",
    inputSchema: {
      contract_id: z
        .string()
        .optional()
        .describe("Contract to verify against. Defaults to the most recent."),
      repo: z
        .string()
        .optional()
        .describe("Repository root. Defaults to the server working directory."),
    },
  },
  async ({ contract_id, repo }) => {
    try {
      const verdict = await verify({ contract_id, repo });
      return { content: [{ type: "text" as const, text: formatVerdict(verdict) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `verify_change failed.\n\n${errorText(err)}` }],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("entire-guard MCP server ready on stdio");
