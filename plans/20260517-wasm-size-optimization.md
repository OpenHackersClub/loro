# Plan: Optimize the `loro-crdt` WASM Bundle Size

Date: 2026-05-17
Status: In Progress
Primary package target: `crates/loro-wasm` → published as `loro-crdt` on npm

## Goals

1. Make the wasm artifact size a first-class, measurable property of the build.
2. Land a series of small, low-risk PRs that each move the gzipped artifact down a measurable amount.
3. Set a hard size budget in CI so future regressions block merge instead of silently inflating the bundle.

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

## Optimization PRs

Each row is one PR. Each PR is small, independently revertible, and reports
its own size delta in the description by re-running `wasm-size-bench.ts`
before and after the change.

| #  | Branch                                    | Change                                                         | Status / impact |
| -- | ----------------------------------------- | -------------------------------------------------------------- | --------------- |
| 1  | `feat/wasm-size-benchmark`                | Add `wasm-size-bench.ts` + this plan                           | none (tooling)  |
| 2  | _dropped_                                 | ~Re-enable `wasm-opt -Oz`~                                     | regresses gzip — see below |
| 3  | `chore/dev-only-pretty-assertions`        | Move `pretty_assertions` from `[dependencies]` to dev-only     | 1–3% gzip (target) |
| 4  | `perf/drop-json-pretty-prod`              | Gate `serde_json::to_string_pretty` behind a feature           | 1–4% gzip (target) |

### Why we dropped `wasm-opt -Oz`

The common wisdom is "wasm-opt -Oz on top of rustc `opt-level=s` saves 5–15%
on gzip." We benchmarked it on this bundle and found the **opposite**:

| Variant                 | Raw bytes   | gzip -9     | brotli -9   |
| ----------------------- | ----------: | ----------: | ----------: |
| baseline (no wasm-opt)  | 3,284,697   | 1,032,464   |   806,622   |
| `wasm-opt -O4`          | 3,033,081 (−7.7%)  | 1,106,433 (+7.2%) | 885,473 (+9.8%) |
| `wasm-opt -Os`          | 2,994,876 (−8.8%)  | 1,097,109 (+6.3%) | 877,273 (+8.8%) |
| `wasm-opt -Oz`          | 2,943,488 (−10.4%) | 1,099,849 (+6.5%) | 880,818 (+9.2%) |

rustc already runs LTO + `opt-level="s"`, and wasm-bindgen already
tree-shakes unused exports. The additional instruction-level rewrites
wasm-opt introduces shrink the raw binary but introduce more diverse
patterns that gzip/brotli compress worse. Net: ~10% raw saving but
~7–10% _larger_ on the wire.

Since shipping a wasm bundle is bottlenecked by transfer size (gzip /
brotli over HTTP), we **do not re-enable wasm-opt** in the build pipeline.
The commented-out invocation in `crates/loro-wasm/scripts/build.ts:82-87`
should stay commented, and we leave a note pointing here.

### PR 1 — Benchmark + Plan (this PR)

Lands the measurement infrastructure and this document. No size impact on the
artifact. Provides a stable yardstick so subsequent PRs can quote a number.

Exit criteria:

- `deno run -A scripts/wasm-size-bench.ts` runs locally against the artifacts
  produced by `pnpm release-wasm` and writes both report files.
- A pinned baseline file (`wasm-size-baseline.json`) is committed.
- Plan doc is committed.

### PR 2 — Dropped after benchmarking

See "Why we dropped `wasm-opt -Oz`" above. The branch slot is left vacant.
The commented-out invocation in `build.ts` should now carry a one-line
comment pointing back at this plan so the next person doesn't re-enable it
without re-checking the data.

### PR 3 — Move `pretty_assertions` to dev-deps

`crates/loro-internal/Cargo.toml:55` currently has `pretty_assertions = "1.4.1"`
in `[dependencies]`. The only `src/` reference is in
`crates/loro-internal/src/state.rs:1548` inside `check_is_the_same`, which is
documented as test-only. That function is reached from the public
`check_state_correctness_slow` API on `LoroDoc`, so we cannot simply delete
the call — but we can swap `pretty_assertions::assert_eq!` for `std::assert_eq!`
in production builds.

Approach:

1. Move `pretty_assertions` from `[dependencies]` to `[dev-dependencies]`.
2. In `state.rs`, swap the call to `std::assert_eq!` (or gate the pretty
   variant behind `#[cfg(any(test, feature = "test_utils"))]`).
3. Verify all tests (which `use pretty_assertions::assert_eq;` directly) keep
   compiling — they pull from dev-deps now, which is the correct scope.

Risk: low. The function's error message becomes less colorful in prod, which
is the intended trade.

### PR 4 — Drop `serde_json::to_string_pretty` from the prod call graph

`crates/loro-internal/src/value.rs:18-19` and `:33-34` define
`to_json_pretty` on the `ToJson` trait and on `LoroValue`. The non-test uses
in `src/` are nil; the prod path always calls `to_json` (non-pretty). The
pretty formatter pulls a separate code path in `serde_json` into the wasm.

Approach (least-disruptive variant):

1. Mark the trait method as `#[cfg(any(test, feature = "test_utils"))]` (or a
   new `json_pretty` feature) so it isn't compiled into the prod wasm.
2. Update the trait's `LoroValue` impl identically.
3. Audit external callers (none expected outside tests/examples) and gate them
   under the same `cfg`.

Risk: low. No user-facing API on `loro-wasm` currently surfaces
`to_json_pretty`. If a downstream Rust consumer relies on it, they can enable
the new feature flag.

## Follow-ups (deferred, not in this plan)

- Make `jsonpath` opt-in (drops `pest` + grammar) — likely the single
  largest individually-addressable win, but a public-API change.
- Make `tracing-wasm` optional behind a `debug` feature.
- Audit `im::HashMap` / `ImVersionVector` against `Arc<FxHashMap>` once
  `cargo bloat` confirms structural-sharing isn't pulling its weight.
- Replace `console_error_panic_hook` with a 5-line `std::panic::set_hook`.

## CI integration

After PR 2, the size delta becomes meaningful enough to gate on. PR 5 (not
yet started) will add a hard ceiling to `.github/workflows/release_wasm.yml`
or a new `wasm-size.yml`, with the budget derived from
`wasm-size-baseline.json` + a generous tolerance. Until then, the existing
in-PR comment in `crates/loro-wasm/scripts/build.ts` continues to report
absolute sizes.

## Decision Log

- 2026-05-17: Plan opened. Baseline measurement pending the first end-to-end
  `pnpm release-wasm` run with the new bench script. The benchmark
  intentionally does **not** invoke the build pipeline itself — it only
  measures post-build artifacts so it can be re-run cheaply.
