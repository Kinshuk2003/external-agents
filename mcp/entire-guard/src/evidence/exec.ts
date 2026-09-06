/**
 * The only place in the codebase that knows external commands exist.
 *
 * Rules enforced here:
 *  - every result carries the literal command string, for verification;
 *  - a non-zero exit is never swallowed -- stderr is surfaced verbatim;
 *  - nothing is ever fabricated when a command fails.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type CommandResult = {
  command: string;
  stdout: string;
  stderr: string;
  ok: boolean;
  /** Present when the command failed; the caller decides degrade vs. throw. */
  error?: string;
};

export function renderCommand(bin: string, args: string[]): string {
  return [bin, ...args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a))].join(" ");
}

export async function runCommand(
  bin: string,
  args: string[],
  opts: { cwd: string; maxBuffer?: number; timeoutMs?: number } = { cwd: process.cwd() },
): Promise<CommandResult> {
  const command = renderCommand(bin, args);
  try {
    const { stdout, stderr } = await run(bin, args, {
      cwd: opts.cwd,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 120_000,
      windowsHide: true,
    });
    return { command, stdout, stderr, ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      command,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      ok: false,
      error: (e.stderr || e.message || "command failed").trim(),
    };
  }
}

/** Parse stdout as JSON, tolerating a leading banner line some CLIs emit. */
export function parseJson<T>(result: CommandResult): T | undefined {
  const text = result.stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    const start = text.search(/[[{]/);
    if (start < 0) return undefined;
    try {
      return JSON.parse(text.slice(start)) as T;
    } catch {
      return undefined;
    }
  }
}

export type JsonlRecord = { line: number; value: unknown };
export type JsonlFailure = { line: number; text: string; error: string };
export type JsonlParse = { records: JsonlRecord[]; failures: JsonlFailure[] };

/**
 * Parse JSONL with per-line error isolation.
 *
 * A transcript can be truncated mid-write, so a single unparseable line must
 * never discard the records that did parse. Failures are returned, never
 * thrown, so the caller can disclose them in degraded[] rather than pretend
 * the session was shorter than it was.
 */
export function parseJsonl(text: string): JsonlParse {
  const records: JsonlRecord[] = [];
  const failures: JsonlFailure[] = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "") continue;
    try {
      records.push({ line: i + 1, value: JSON.parse(raw) as unknown });
    } catch (err) {
      failures.push({
        line: i + 1,
        text: raw.length > 200 ? raw.slice(0, 200) + "..." : raw,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { records, failures };
}
