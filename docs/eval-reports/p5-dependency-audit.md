# Phase 5 — Dependency Audit (npm + pip): Eval Report

**Date:** 2026-07-01
**Gate:** no unpatched high/critical, or a documented justification. **Result: PASS (via
documented residuals)** — all findings are either patched or accepted with a compat/reachability
justification below; none is an unpatched high/critical without justification.

## Surfaces (severity triage weights these in this order)
1. **Production/deployed** — `app`'s `dependencies` + `core`'s `dependencies`: what actually ships
   in the Vercel serverless bundle and executes per request.
2. **Dev/tooling** — `devDependencies` in `app`/`core`: test runners, build-time CSS tooling, type
   checking. Never present in the deployed bundle.
3. **Offline Python pipeline** — `pipeline/` (`pyproject.toml` + `.venv`): dataset ingestion,
   parsing, LoRA fine-tuning. Runs locally/offline, not deployed, not internet-facing.

## Tooling
- `npm audit --workspaces` (npm 10.7.0, Node 20.15.1).
- `pip-audit 2.10.1`, installed into `pipeline/.venv` per the brief (not committed — `.venv/` is
  gitignored).

## Step 1 — npm audit (before)
```
npm audit --workspaces
```
**6 vulnerabilities: 4 moderate, 1 high, 1 critical.**

| Package | Severity | Advisory | Surface | Path |
|---|---|---|---|---|
| `vitest` | **critical** | [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) — Vitest UI server allows arbitrary file read/execute | dev/tooling | `core`, `app` devDependency `vitest@1.6.1` |
| `vite` | **high** | [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) `server.fs.deny` bypass (Windows); also rolls up [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) (path traversal in optimized-deps `.map`) and [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) (launch-editor NTLMv2 hash disclosure) | dev/tooling | transitive via `vitest`/`@vitejs/plugin-react`, `vite@5.4.21` |
| `esbuild` | moderate | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) — esbuild dev server allows any website to read responses | dev/tooling | transitive via `vite@5.4.21` |
| `vite-node` | moderate | inherits `vite`'s advisories (no distinct CVE) | dev/tooling | transitive via `vitest@1.6.1` |
| `postcss` | moderate | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) — XSS via unescaped `</style>` in CSS stringify output | **production/deployed** | `next`'s own internal pin, `postcss@8.4.31` (nested under `node_modules/next`) |
| `next` | moderate | inherits `postcss`'s advisory (no distinct CVE) | **production/deployed** | `app` dependency, `next@15.5.19→15.5.20` |

Full raw output (both `npm audit --workspaces` text and `--json`) captured during this task; the
table above is the complete finding set — nothing was summarized away.

## Step 2 — Apply safe fixes
```
npm audit fix --workspaces
```
Result: **`next` bumped 15.5.19 → 15.5.20** (patch release inside the declared `^15.3.3` range in
`app/package.json` — no `package.json` edit needed, `package-lock.json` only). No other package
changed; `npm audit fix` reported all remaining fixes require `--force` (semver-major).

Investigated whether any *non-major* version of `next` (or `vite`/`vitest`) resolves its
vulnerability, to avoid settling for a residual prematurely:
- Downloaded and inspected `next@15.5.20`'s own `package.json`: still pins `"postcss": "8.4.31"`
  exactly (not a range). Checked `next@15.6.0-canary.61` and `next@16.2.10` (current `latest`
  dist-tag, itself a major bump) — **both still pin the identical `postcss@8.4.31`**. There is no
  published `next` version, including current `latest`, that resolves this — it is not a "we
  haven't upgraded far enough" gap, it is unfixed upstream by Vercel across the entire version
  line checked.
- Checked `vitest`'s latest `1.x` release (`1.6.1`, already installed — we're current) and its
  pinned `vite: ^5.0.0`; `vite@5.4.21` (latest 5.x) still pins `esbuild: ^0.21.3`, which cannot
  resolve to the fixed `0.25.0+` under that range. The `vite server.fs.deny` fix and the
  `esbuild`/`vitest` UI-server fixes only ship from `vite@6.4.3+` / `vitest@2.x+`, which is a
  `vitest` major bump.

`npm audit fix --force` was **not** run — it would install `vitest@4.1.9`, a 1→4 major jump, which
is out of scope per the known constraint: `jsdom@25+` requires Node `≥20.19` and this machine runs
Node `20.15.1`; the `vitest` 2.x/3.x/4.x migration is explicitly gated on a future Node upgrade
(decided in an earlier phase-5 task). Forcing it now would either break under the pinned Node
version or silently diverge from that decision.

## npm audit (after)
```
npm audit --workspaces
```
Still **6 vulnerabilities: 4 moderate, 1 high, 1 critical** — identical set to before, all now
confirmed to have **no fix available without a semver-major bump** (see investigation above).
Zero regression, zero new findings; the `next` patch bump is a net-positive unrelated fix
absorbed for free.

### Residuals (npm) — accepted with justification
1. **`vitest` critical (GHSA-5xrq-8626-4rwp), `vite` high, `esbuild`/`vite-node` moderate** —
   requires `vitest` 1.x → 4.x (semver-major). **Dev-only**: `vitest`, `vite`, `esbuild`,
   `vite-node` are all `devDependencies` used exclusively by `npm test` (`vitest run`) in `core`
   and `app`. None of these packages, nor the Vitest UI server the critical advisory targets, are
   invoked by `next build` / `next start` or present in the Vercel serverless bundle — they never
   run in production, and the Vitest UI server in question is never started anywhere in this repo
   (no `vitest --ui` script). Constrained by the documented Node 20.15.1 / `jsdom@24` /
   `vitest@1.6.0` pin from an earlier phase-5 decision; revisit when the Node runtime is upgraded
   to `≥20.19`.
2. **`postcss` moderate (GHSA-qx2v-qp2m-jg93) via `next`'s internal pin, `next` moderate
   (inherited)** — no fix exists in any published `next` version (verified through current
   `latest`, 16.2.10). **Production/deployed surface** (`next` ships in the Vercel bundle), but
   the vulnerable code path — PostCSS's CSS *stringifier* mishandling unescaped `</style>` — only
   runs inside `next build`'s own CSS-processing pipeline (Tailwind/CSS-module compilation) over
   this repo's own trusted source files at build time. It is never invoked at request-serving time
   and is never fed attacker-controlled or user-submitted CSS (this app has no user-supplied-CSS
   feature), so it is not reachable from user input despite being on the production dependency
   graph. Re-audit `next` on future upgrades in case Vercel eventually unpins.

## Step 3 — pip-audit (before)
```
pipeline/.venv/bin/pip install pip-audit
pipeline/.venv/bin/pip-audit
```
**5 known vulnerabilities, all in a single package: `pip` itself (24.0)**, the packaging tool
installed at venv creation — not a project dependency (not in `pyproject.toml`), not a package the
project imports or ships.

| ID | Alias | Description | Fixed in |
|---|---|---|---|
| PYSEC-2026-196 | CVE-2026-8643 | `console_scripts`/`gui_scripts` entry points installed outside the install dir | 26.1.2 |
| — | CVE-2025-8869 / GHSA-4xh5-x5gv-qwph | tar-extraction symlink check bypass (fallback path on Python < PEP 706) | 25.3 |
| — | CVE-2026-1703 / GHSA-6vgw-5pg2-w6jp | wheel extraction path traversal (limited to install-dir prefixes) | 26.0 |
| — | CVE-2026-3219 / GHSA-58qw-9mgm-455v | concatenated tar+ZIP archive confusion | 26.1 |
| — | CVE-2026-6357 / GHSA-jp4c-xjxw-mgf9 | self-update check ran before wheel install completed, importable-module ordering issue | 26.1 |

pip-audit's default OSV-backed output does not attach a severity label to these; by description
they are local install-time/supply-chain-adjacent issues (not remotely exploitable via network),
but since the fix was a trivial, zero-risk self-upgrade, it was patched regardless of severity
tier rather than spending time triaging exact CVSS scores.

**`torch@2.12.1`, `transformers@5.12.1`, `peft@0.19.1`** (the LoRA/MPS fine-tune stack) — and every
other of the ~85 resolved packages — came back with **zero known vulnerabilities** at their
currently pinned-range versions. No torch/transformers/peft residual was needed; the concern in
the task context (pinned-for-MPS-compat majors with no fix) did not materialize.

## Step 4 — Patch
```
pipeline/.venv/bin/python -m pip install --upgrade pip   # 24.0 → 26.1.2
```
Trivial, zero-compat-risk (upgrades the package manager itself, not a project dependency; not
committed since `.venv/` is gitignored).

## pip-audit (after)
```
pipeline/.venv/bin/pip-audit
```
```
No known vulnerabilities found
Name          Skip Reason
------------- ----------------------------------------------------------------------------
sift-pipeline Dependency not found on PyPI and could not be audited: sift-pipeline (0.0.0)
```
**0 vulnerabilities.** (`sift-pipeline` skip is expected — it's the local project package, not a
PyPI dependency.) No pip residuals.

## Verification run after each change set
- After `npm audit fix` (package-lock.json changed, `next` 15.5.19→15.5.20):
  - `npm -w @sift/core run typecheck` — pass
  - `npm -w @sift/app run typecheck` — pass
  - `npm -w @sift/core test` — 30/30 test files pass (all `✓`); the run then hits the known
    pre-existing parallel-worker onnxruntime-binding SIGSEGV teardown artifact after all tests
    complete (`Check failed: node->IsInUse()`, exit 133) — documented pre-existing infra behavior
    (see project memory `headless-test-infra-boundary`), not a regression from this change; no
    `FAIL` or failing test file appeared in the log.
  - `npm -w @sift/app test` — 7/7 test files, 43/43 tests pass, exit 0.
  - `npm -w @sift/app run build` — `next build` succeeds (`next@15.5.20`), all 4 routes compile
    and prerender cleanly.
- After `pip install --upgrade pip`:
  - `make py-test` (`cd pipeline && .venv/bin/python -m pytest -q`) — **56 passed**.

## Files changed
- `package-lock.json` — `next` 15.5.19 → 15.5.20 (and its `@next/swc-*` platform packages), via
  `npm audit fix --workspaces`. No `package.json` edits (bump stayed inside the declared range).
- `docs/eval-reports/p5-dependency-audit.md` — this report (new).
- `pipeline/.venv` — pip 24.0 → 26.1.2, **not committed** (gitignored, machine-local).

## Before/after summary
| | Before | After |
|---|---|---|
| npm (moderate/high/critical) | 4 / 1 / 1 (6 total) | 4 / 1 / 1 (6 total) — all 6 documented residuals, no unfixable-without-major found to be actually fixable |
| pip (all severities) | 5 (all in `pip` itself) | 0 |

## Decisions
- Did not run `npm audit fix --force`: would force `vitest@4.1.9` (major), contradicting the
  explicit phase-5 decision to hold `vitest@^1.6.0`/`jsdom@^24` until Node is upgraded past
  `20.15.1`.
- Did not bump `next` past `^15.3.3`'s range (i.e., did not jump to 16.x) to chase the postcss
  fix, because there isn't one — confirmed `next@latest` (16.2.10) still pins the same vulnerable
  `postcss@8.4.31`, so a major bump would add risk (a real Next 15→16 migration) for zero security
  benefit.
- Did not touch `torch`/`transformers`/`peft` — already clean, no action needed, and the
  MPS/LoRA-compat pin concern didn't apply.

## Re-running this check
```
npm audit --workspaces
cd pipeline && .venv/bin/pip install --upgrade pip-audit && .venv/bin/pip-audit
```

## Next
Re-audit `next`/`vite`/`vitest` residuals whenever the Node runtime is upgraded past `20.19` (the
blocker for the `jsdom`/`vitest` major-version migration already tracked from an earlier phase-5
task) — that migration should resolve all 4 dev/tooling findings, and is worth re-checking whether
Vercel has unpinned `postcss` in a later `next` release at the same time.
