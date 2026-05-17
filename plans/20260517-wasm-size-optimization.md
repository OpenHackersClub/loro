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

All "impact" figures are measured against the pinned baseline
(`wasm-size-baseline.json` — bundler at HEAD `d4fdfdaf`: 3.21 MB raw /
1.02 MB gzip / 706 KB brotli). They come from a real wasm rebuild with
the change applied, not from an estimate.

| #  | Branch                                    | Change                                                                | gzip Δ          | brotli Δ       |
| -- | ----------------------------------------- | --------------------------------------------------------------------- | --------------- | -------------- |
| 1  | `feat/wasm-size-benchmark`                | Add `wasm-size-bench.ts` + this plan + pinned baseline                | none (tooling)  | none (tooling) |
| 2  | `perf/inline-panic-hook`                  | Replace `console_error_panic_hook` with inline `std::panic::set_hook` | −0.3 KB / −0.03% | −0.6 KB / −0.08% |
| 3  | `perf/tracing-release-max-level-off`      | Add `release_max_level_off` to the `tracing` dep in `loro-wasm`       | −14 KB / −1.47% | −10 KB / −1.55% |
| 4  | `perf/optional-tracing-wasm`              | Gate `tracing-wasm` (and `setDebug`) behind a default-off `debug` feature | −12 KB / −1.15% | −9 KB / −1.18% |
| 5  | `perf/jsonpath-optional-feature`          | Make `jsonpath` a cargo feature (kept in `default`) — non-breaking    | 0 (default unchanged) | 0 |
| 6  | _deferred_                                | Flip `jsonpath` default-off + ship `loro-crdt-jsonpath` companion     | −66 KB / −6.55% | −44 KB / −6.2% |

Phases 3-4 are landed size wins. Phase 5 is mechanical groundwork: it
makes the lean build *possible* (`--no-default-features` drops
−66 KB gzip) without changing the published artifact. Phase 6 is what
actually delivers that −66 KB to npm users, and is deferred because it
is a semver-major break plus a publish-flow change.

Stacked, Phases 3-4 + 6 deliver roughly **−92 KB gzip / ~9%** off the
default `loro-crdt` bundle, with `loro-crdt-jsonpath` available for
users who need the heavier feature.

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

### Phase 3 — Elide `tracing` macros via `release_max_level_off`

In release builds, the `tracing` facade still walks its callsite
machinery to decide whether to record an event. The `release_max_level_off`
feature (documented escape hatch) elides the macros at compile time so
the check disappears entirely. Loro uses `tracing` heavily inside
`loro-internal` (`info_span!`, `instrument`, `warn`), and the wasm
artifact pays for every callsite.

Approach:

1. Add to `crates/loro-wasm/Cargo.toml` after `tracing-wasm`:
   ```toml
   tracing = { version = "0.1", features = ["release_max_level_off"] }
   ```
   Placing this in `loro-wasm/Cargo.toml` (not `loro-internal`) scopes
   the elision to the wasm package via cargo's feature unification —
   crates.io consumers of `loro` / `loro-internal` keep full tracing.

Measured against the pinned baseline: −39,547 raw / −14,314 gzip /
−10,551 brotli (−1.28% / −1.47% / −1.55%).

Risk: low. Functional behavior unchanged; only release-build log
output disappears. `tracing_wasm::set_as_global_default()` keeps
working; it just sees no events to forward.

### Phase 4 — Gate `tracing-wasm` behind a `debug` feature

`crates/loro-wasm/Cargo.toml` has `tracing-wasm = "0.2.1"` as an
unconditional dependency. The only call site is `set_debug()` in
`crates/loro-wasm/src/lib.rs:84-87`, which installs
`tracing-subscriber` as the global subscriber. With Phase 3 in place,
no events ever reach that subscriber in release builds, so the entire
`tracing-subscriber` + `sharded-slab` graph is dead weight in the
default artifact.

Approach:

1. Add a `debug` feature to `crates/loro-wasm/Cargo.toml`, default OFF.
   Mark `tracing-wasm` as `optional = true` and route it through the
   feature.
2. Wrap `set_debug()` in `#[cfg(feature = "debug")]`. Provide a
   non-feature stub that returns `Err(JsError::new("debug logging
   not compiled in — rebuild loro-wasm with the `debug` feature"))`
   so JS callers get a clear runtime error instead of a silent no-op.
3. Update the two internal vitest files that call `setDebug()`
   (`crates/loro-wasm/tests/awareness.test.ts:48`,
   `crates/loro-wasm/tests/ephemeral.test.ts:35`) to drop the call —
   neither test's assertion depends on tracing output.

Measured against the pinned baseline: −31,835 raw / −11,968 gzip /
−9,233 brotli (−0.97% / −1.15% / −1.18%). `tracing-subscriber` and
`sharded-slab` drop entirely; `tracing-core` stays because the
no-op facade is still referenced from `loro-internal`.

Risk: low. The public TypeScript surface keeps the `setDebug` symbol;
behavior under the lean build is a clear error rather than silent
nothing.

### Phase 5 — Make `jsonpath` an opt-in cargo feature (non-breaking)

`crates/loro-wasm/Cargo.toml` hardcoded `jsonpath` in the
`loro-internal` feature list, pulling the `pest` parser, its generated
grammar, and ~190 KB of monomorphized parser-state + selector code
into every published `loro-crdt` install — whether the user calls
`LoroDoc.JSONPath` or not.

This phase converts `jsonpath` into a proper cargo feature **without
changing the published artifact**:

1. `crates/loro-internal/Cargo.toml`: `pest` / `pest_derive` become
   `optional`; the existing `jsonpath` feature declares them
   (`jsonpath = ["dep:pest", "dep:pest_derive"]`). The `jsonpath`
   module was already `#[cfg(feature = "jsonpath")]`.
2. `crates/loro-wasm/Cargo.toml`: drop the hardcoded `"jsonpath"` from
   the `loro-internal` dependency; add a `jsonpath` feature that
   re-enables it — **kept in `default`**.
3. `crates/loro-wasm/src/lib.rs`: cfg-gate the `JSONPath()` /
   `subscribeJsonpath()` exports and the manual `subscribeJsonpath`
   TypeScript behind `#[cfg(feature = "jsonpath")]`.

Because `jsonpath` stays in `default`, the published artifact is
byte-for-byte unchanged — this phase is non-breaking. What it adds is
the lean build path: `--no-default-features` drops the JSONPath
subsystem.

Measured: default build unchanged (raw byte-identical to baseline);
`--no-default-features` lean build is −188.8 KB raw / −66.5 KB gzip /
−43.8 KB brotli (−5.89% / −6.55% / −6.19%).

Risk: low. Non-breaking groundwork.

### Phase 6 — Flip the default and ship `loro-crdt-jsonpath` (deferred)

Phase 5 makes the lean build *possible*; Phase 6 makes it the
*published default* and is where the −66 KB actually reaches npm
users. Deferred because it is both a semver-major break and a
publish-flow change.

Approach:

1. `crates/loro-wasm/Cargo.toml`: drop `jsonpath` from `default`.
2. Extend `crates/loro-wasm/scripts/build.ts` to additionally build a
   `--features jsonpath` variant and publish it as a second npm
   package, `loro-crdt-jsonpath`. The existing `loro-crdt-map`
   companion (per `build.ts`) is the sibling-package precedent.
3. Wire the second package into the changeset / `release_wasm.yml`
   publish flow.
4. Add a changeset note + a README migration paragraph: `loro-crdt`
   consumers calling `LoroDoc.JSONPath()` / `subscribeJsonpath()`
   switch to `loro-crdt-jsonpath`.

Risk: medium — public JS API of the default package loses
`LoroDoc.JSONPath()` and `LoroDoc.subscribeJsonpath()`; the build and
publish pipeline roughly doubles. Needs its own focused PR.

## Stacking and ordering

Phases 3 and 4 measure independently because Agent C measured Phase 3
without Phase 4 applied, and Agent B measured Phase 4 without Phase 3.
They are likely close to additive, since they remove different code
paths (compile-time macro elision vs. subscriber-side DCE) — but a
combined-measurement check in the implementing PR is a sanity step
worth doing.

Phase 5 is independent of Phases 3-4 (different crates entirely), so a
reviewer-friendly order is:

```
2 (panic hook) → 3 (release_max_level_off) → 4 (tracing-wasm gate) → 5 (jsonpath feature) → 6 (jsonpath split)
```

## Follow-ups (deferred, not in this plan)

- **`Arc<FxHashMap>` vs `im::HashMap`** for `ImVersionVector` — twiggy
  shows `im` only costs ~4.8 KB code so the marginal raw win is small,
  but it would unlock dropping `sized-chunks` (~2 KB) and `bitmaps`.
  Worth revisiting once Phase 6 lands and the bigger items are off
  the board.
- **Unifying duplicated `itertools` 0.11 + 0.12** — needs an upstream
  bump of `generic-btree` and `serde_columnar` (both `loro-dev`
  crates). ~5-6 KB raw savings.
- **`std::sync::ReentrantLock` instead of `parking_lot::ReentrantMutex`**
  (stable since 1.85; project uses 1.93). Marginal (~3.5 KB raw).
- **Gate `serde_json::to_string_pretty` behind a `json_pretty` feature**
  once a reachability path from `loro-wasm` is demonstrated (currently
  dead-coded by LTO, so the change is purely API hygiene).

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
- 2026-05-17: Phases 3-5 added after measuring three candidate changes
  with separate proof-of-concept rebuilds. Headline numbers in the
  table above all come from real wasm builds, not estimates. The full
  measurement reports for jsonpath, tracing-wasm gating, and the
  `release_max_level_off` finding are summarized in the
  corresponding phase sections.
- 2026-05-18: Original Phase 5 (jsonpath companion package) split into
  Phase 5 (non-breaking cargo-feature groundwork) and a deferred
  Phase 6 (flip default + ship `loro-crdt-jsonpath`). Rationale:
  removing `LoroDoc.JSONPath()` from the default `loro-crdt` package
  is a semver-major break and the dual-package publish flow is a
  large, hard-to-test build-script change — both deserve their own
  focused PR rather than riding along with the mechanical gating.
