# Plan: Optimize the `loro-crdt` WASM Bundle Size

Date: 2026-05-17
Status: In Progress
Primary package target: `crates/loro-wasm` → published as `loro-crdt` on npm

## Goals

1. Make the wasm artifact size a first-class, measurable property of the build.
2. Land a series of small, low-risk phases that each move the gzipped artifact
   in the right direction.
3. Set a hard size budget in CI so future regressions block merge instead of
   silently inflating the bundle.

Non-goals (out of scope for this plan):

- Functional behavior changes.
- Removing public APIs or feature flags without a deprecation path.
- Refactors that don't directly reduce size.

## Measurement

A new Deno script — `scripts/wasm-size-bench.ts` — measures the post-build artifacts at
`crates/loro-wasm/{bundler,browser,nodejs,web}/loro_wasm_bg.wasm` and writes:

- `wasm-size-report.json` — machine-readable, suitable for diffing.
- `wasm-size-report.md` — human-readable, suitable for PR comments.
- `wasm-size-baseline.json` — optional pinned baseline used for delta comparison.

Workflow:

```sh
pnpm release-wasm                          # produce artifacts
deno run -A scripts/wasm-size-bench.ts     # measure + report
deno run -A scripts/wasm-size-bench.ts --update-baseline  # pin a new baseline
```

The existing in-pipeline reporter in `crates/loro-wasm/scripts/build.ts` still
posts a PR comment with bundler-only sizes; this script complements it by
covering all four targets and producing a delta against a pinned baseline.

## Findings from prior research

The standard size profile is already tuned in `crates/loro-wasm/.cargo/config.toml`
(`lto=true`, `opt-level="s"`, `codegen-units=1`, `strip=true`). The build
pipeline also strips `target_features` (Safari 16.0-16.3 fallback), strips debug
info after extracting sourcemaps, and uses `wasm-bindgen --weak-refs`. The
easy compiler knobs are tuned. The remaining wins are at the build pipeline
and dependency level.

## Optimization Phases

Each row is one phase. Each phase is small, independently revertible, and
reports its own size delta in the PR description by re-running
`wasm-size-bench.ts` before and after the change.

| #  | Branch                                    | Change                                                                | Impact          |
| -- | ----------------------------------------- | --------------------------------------------------------------------- | --------------- |
| 1  | `feat/wasm-size-benchmark`                | Add `wasm-size-bench.ts` + this plan + pinned baseline                | none (tooling)  |
| 2  | `perf/inline-panic-hook`                  | Replace `console_error_panic_hook` with inline `std::panic::set_hook` | ~0.3 KB gzip    |

### Phase 1 — Benchmark + Plan

Lands the measurement infrastructure and this document. No size impact on the
artifact. Provides a stable yardstick so subsequent phases can quote a number.

Exit criteria:

- `deno run -A scripts/wasm-size-bench.ts` runs locally against the artifacts
  produced by `pnpm release-wasm` and writes both report files.
- A pinned baseline file (`wasm-size-baseline.json`) is committed.
- Plan doc is committed.

### Phase 2 — Replace `console_error_panic_hook` with an inline hook

`loro-wasm` pulls `console_error_panic_hook` for one call:
`console_error_panic_hook::set_once()` in the `#[wasm_bindgen(start)]`
function. The crate's main work is to install a `std::panic::set_hook` that
pipes the panic info into `console.error` and appends a JavaScript-side
`Error.stack`.

Approach:

1. Replace the call with a six-line `std::panic::set_hook`, guarded by
   `std::sync::Once`, that routes through the existing
   `crate::log::error` extern (already linked for `console_error!` /
   `console_log!`).
2. Remove `console_error_panic_hook` from `crates/loro-wasm/Cargo.toml`
   and `Cargo.lock`.

Trade-off: panic messages no longer carry the JS `Error.stack`. The Rust
`PanicInfo` (file + line + payload) is what's actionable for a CRDT
library; the JS stack rarely surfaces useful information beyond
"called from JS wrapper". Downstream consumers who want it back can
install their own hook from JS.

Risk: low.

## Follow-ups (deferred, not in this plan)

- Make `jsonpath` opt-in (drops `pest` + grammar) — likely the single
  largest individually-addressable win, but a public-API change.
- Make `tracing-wasm` optional behind a `debug` feature (drops
  `tracing-subscriber` + `sharded-slab` from the published artifact).
- Audit `im::HashMap` / `ImVersionVector` against `Arc<FxHashMap>` once
  `cargo bloat` confirms structural-sharing isn't pulling its weight.
- Gate `serde_json::to_string_pretty` behind a `json_pretty` feature once a
  reachability path from `loro-wasm` is demonstrated (currently dead-coded
  by LTO, so the change is purely API hygiene).

## CI integration

A follow-up phase will add a hard ceiling to `.github/workflows/release_wasm.yml`
or a new `wasm-size.yml`, with the budget derived from
`wasm-size-baseline.json` + a generous tolerance. Until then, the existing
in-PR comment in `crates/loro-wasm/scripts/build.ts` continues to report
absolute sizes.

## Decision Log

- 2026-05-17: Plan opened. Baseline pinned at commit `d4fdfdaf`
  (bundler ≈ 3.21 MB raw / 1.02 MB gzip / 706 KB brotli). The benchmark
  intentionally does **not** invoke the build pipeline itself — it only
  measures post-build artifacts so it can be re-run cheaply.
