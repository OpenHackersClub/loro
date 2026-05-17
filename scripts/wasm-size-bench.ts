// Measure published wasm artifact sizes per target and write a report.
//
// Usage:
//   deno run -A scripts/wasm-size-bench.ts            # writes wasm-size-report.json + .md
//   deno run -A scripts/wasm-size-bench.ts --update-baseline
//                                                       # also overwrites wasm-size-baseline.json
//   deno run -A scripts/wasm-size-bench.ts --compare <baseline.json>
//                                                       # compare against a specific baseline file
//
// Prerequisite: build the wasm artifacts first (`pnpm release-wasm`).
// This script does not invoke cargo or wasm-bindgen — it only measures the
// post-build artifacts at crates/loro-wasm/{target}/loro_wasm_bg.wasm.

import * as path from "https://deno.land/std@0.224.0/path/mod.ts";
import { gzip } from "https://deno.land/x/compress@v0.4.5/mod.ts";
// Pinned: brotli output must be reproducible so `wasm-size-baseline.json`
// stays comparable across runs (this script is run with `--no-lock`).
import brotliPromise from "npm:brotli-wasm@3.0.1";

const TARGETS = ["bundler", "browser", "nodejs", "web"] as const;
type Target = (typeof TARGETS)[number];

interface TargetMetrics {
  raw: number;
  gzip: number;
  brotli: number;
}

interface Report {
  generatedAt: string;
  commit: string | null;
  targets: Record<Target, TargetMetrics | null>;
}

const __dirname = path.dirname(path.fromFileUrl(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const wasmDir = path.resolve(repoRoot, "crates/loro-wasm");
const reportJsonPath = path.resolve(repoRoot, "wasm-size-report.json");
const reportMdPath = path.resolve(repoRoot, "wasm-size-report.md");
const baselinePath = path.resolve(repoRoot, "wasm-size-baseline.json");

const args = parseArgs(Deno.args);

async function main(): Promise<void> {
  // Resolve the baseline first so an explicit `--compare` with a bad
  // path fails before any measurement work or file writes.
  const baseline = await loadBaseline(
    args.compareWith ?? baselinePath,
    args.compareWith !== null,
  );

  const brotli = await brotliPromise;
  const report: Report = {
    generatedAt: new Date().toISOString(),
    commit: await currentCommit(),
    targets: emptyTargets(),
  };

  for (const target of TARGETS) {
    const wasmPath = path.resolve(wasmDir, target, "loro_wasm_bg.wasm");
    try {
      const bytes = await Deno.readFile(wasmPath);
      report.targets[target] = {
        raw: bytes.length,
        gzip: gzip(bytes).length,
        brotli: brotli.compress(bytes).length,
      };
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        console.warn(`⚠️  Missing ${wasmPath} — run \`pnpm release-wasm\` first.`);
        report.targets[target] = null;
        continue;
      }
      throw err;
    }
  }

  await Deno.writeTextFile(reportJsonPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`📝  Wrote ${path.relative(repoRoot, reportJsonPath)}`);

  const md = renderMarkdown(report, baseline);
  await Deno.writeTextFile(reportMdPath, md);
  console.log(`📝  Wrote ${path.relative(repoRoot, reportMdPath)}`);
  console.log("\n" + md);

  if (args.updateBaseline) {
    await Deno.writeTextFile(baselinePath, JSON.stringify(report, null, 2) + "\n");
    console.log(`📌  Updated ${path.relative(repoRoot, baselinePath)}`);
  }
}

function parseArgs(input: string[]) {
  let updateBaseline = false;
  let compareWith: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const a = input[i];
    if (a === "--update-baseline") {
      updateBaseline = true;
    } else if (a === "--compare") {
      const value = input[++i];
      if (value === undefined) {
        throw new Error("--compare requires a baseline file path");
      }
      compareWith = value;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { updateBaseline, compareWith };
}

function emptyTargets(): Record<Target, TargetMetrics | null> {
  return Object.fromEntries(TARGETS.map((t) => [t, null])) as Record<Target, TargetMetrics | null>;
}

async function currentCommit(): Promise<string | null> {
  try {
    const rev = await new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
      cwd: repoRoot,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (rev.code !== 0) return null;
    const sha = new TextDecoder().decode(rev.stdout).trim();

    // A dirty working tree means the measured artifact does not
    // correspond to `sha` — mark it so the report isn't misleading.
    const status = await new Deno.Command("git", {
      args: ["status", "--porcelain"],
      cwd: repoRoot,
      stdout: "piped",
      stderr: "null",
    }).output();
    const dirty = status.code === 0 &&
      new TextDecoder().decode(status.stdout).trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}

// `required` is true when the path came from an explicit `--compare`:
// a missing or malformed file is then a user error and must not be
// silently skipped. The default baseline remains optional.
async function loadBaseline(p: string, required: boolean): Promise<Report | null> {
  let txt: string;
  try {
    txt = await Deno.readTextFile(p);
  } catch {
    if (required) {
      console.error(`❌  --compare baseline not found or unreadable: ${p}`);
      Deno.exit(1);
    }
    return null;
  }
  try {
    return JSON.parse(txt) as Report;
  } catch {
    if (required) {
      console.error(`❌  --compare baseline is not valid JSON: ${p}`);
      Deno.exit(1);
    }
    return null;
  }
}

function renderMarkdown(report: Report, baseline: Report | null): string {
  const lines: string[] = [];
  lines.push("# WASM Size Report");
  lines.push("");
  lines.push(`- Generated: \`${report.generatedAt}\``);
  if (report.commit) lines.push(`- Commit: \`${report.commit}\``);
  if (baseline) {
    lines.push(
      `- Baseline: \`${baseline.commit ?? "unknown"}\` @ \`${baseline.generatedAt}\``,
    );
  }
  lines.push("");
  lines.push("| Target | Raw | Gzip | Brotli |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const target of TARGETS) {
    const m = report.targets[target];
    const b = baseline?.targets[target] ?? null;
    if (!m) {
      lines.push(`| \`${target}\` | _missing_ | _missing_ | _missing_ |`);
      continue;
    }
    lines.push(
      `| \`${target}\` | ${fmt(m.raw, b?.raw)} | ${fmt(m.gzip, b?.gzip)} | ${
        fmt(m.brotli, b?.brotli)
      } |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function fmt(bytes: number, baseline: number | null | undefined): string {
  const kb = (bytes / 1024).toFixed(2) + " KB";
  if (baseline == null || baseline === bytes) return kb;
  const deltaBytes = bytes - baseline;
  const deltaPct = (deltaBytes / baseline) * 100;
  const sign = deltaBytes > 0 ? "+" : "";
  return `${kb} (${sign}${(deltaBytes / 1024).toFixed(2)} KB / ${sign}${deltaPct.toFixed(2)}%)`;
}

await main();
