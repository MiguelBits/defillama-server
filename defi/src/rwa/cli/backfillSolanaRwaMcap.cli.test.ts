/**
 * Runtime CLI integration test for backfillSolanaRwaMcap.
 *
 * Spawns the script as a child process to verify the input-validation guards
 * actually fire BEFORE any DB connection is attempted. The validations live at
 * module load time so a process-level test is the only honest way to confirm
 * they take effect — a `require()` would cascade into main() and try to open PG.
 *
 * Each spawn pays a ts-node startup cost (~5-10s), so test cases are kept tight.
 */
import { spawnSync, SpawnSyncReturns } from "child_process";
import * as path from "path";

const SCRIPT = path.resolve(__dirname, "backfillSolanaRwaMcap.ts");
const TS_NODE = path.resolve(__dirname, "../../../node_modules/.bin/ts-node");
const REPO_DEFI_DIR = path.resolve(__dirname, "../../..");

function runCli(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(TS_NODE, ["--transpile-only", SCRIPT, ...args], {
    encoding: "utf8",
    cwd: REPO_DEFI_DIR,
    timeout: 60_000,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
  });
}

describe("backfillSolanaRwaMcap CLI input validation (runtime)", () => {
  jest.setTimeout(120_000);

  it("rejects --flat-nav with a non-numeric value", () => {
    const r = runCli(["--flat-nav", "abc"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--flat-nav "abc"');
    expect(r.stderr).toContain("must be a positive number");
  });

  it("rejects --flat-nav 0 (must be strictly positive — division by 0 → Infinity)", () => {
    const r = runCli(["--flat-nav", "0"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("must be a positive number");
  });

  it("rejects --flat-nav with a negative value", () => {
    const r = runCli(["--flat-nav", "-1.5"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("must be a positive number");
  });

  it("rejects --from-date that silently rolls (Feb 31 → Mar 3) without round-trip validation", () => {
    const r = runCli([
      "--asset-id", "test",
      "--mint", "test",
      "--csv", "/tmp/does-not-need-to-exist.csv",
      "--from-date", "2026-02-31",
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--from-date "2026-02-31"');
    expect(r.stderr).toContain("not a valid YYYY-MM-DD date");
  });

  it("rejects --from-date that doesn't match YYYY-MM-DD shape", () => {
    const r = runCli([
      "--asset-id", "test",
      "--mint", "test",
      "--csv", "/tmp/does-not-need-to-exist.csv",
      "--from-date", "2026/02/15",
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not a valid YYYY-MM-DD date");
  });

  it("rejects when required args (--asset-id, --mint, --csv) are missing", () => {
    const r = runCli([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--asset-id, --mint, --csv are all required");
  });

  it("accepts a well-formed --from-date (Feb 28, 2026 — last valid day of February)", () => {
    // Pass a valid from-date AND a deliberately missing required arg, so the
    // script exits at the required-arg check rather than the date check.
    // This isolates: "the date parser doesn't false-reject a valid date".
    const r = runCli(["--from-date", "2026-02-28"]);
    expect(r.status).toBe(1);
    // The error should be the missing-required-args one, NOT a date parse error.
    expect(r.stderr).toContain("--asset-id, --mint, --csv are all required");
    expect(r.stderr).not.toContain("is not a valid YYYY-MM-DD date");
  });
});
