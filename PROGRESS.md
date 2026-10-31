# Kailashe — Progress

## G0 — SPEC + TASKS approval

- Date: 2026-10-29
- Status: approved by owner directive to build start-to-finish without questions
- Files: `docs/SPEC.md` (Q1–Q12 incorporated), `TASKS.md` (S0–S15)

---

## Implementation run — 2026-10-29 (parallel agents, integrated by lead)

Built by parallel sub-agents, each owning one package directory, then integrated
and verified centrally. Branch: `slice/s0-foundations`.

**Final verification: `pnpm build` ✓ · `pnpm typecheck` ✓ · `pnpm lint` ✓ ·
`pnpm test` ✓ — 535 tests, 0 failures.** Breakdown: core 166, deploy 119,
scan 85, cli 55, compose 44, plan 30, market 25, mcp 11. Safety greps: no
`shell: true` anywhere; no `any` in sources. Smoke: `kailashe --version`
0.1.0, `kailashe doctor` ok, `kailashe validate-pack` ok on the real pack,
evals detector accuracy 30/30 (100%, threshold 90%).

### Slice reports (Appendix B, condensed)

- **S0 Foundations** — pnpm workspace (8 packages), TS strict, CI 3-OS,
  exit codes §2.5 with typed errors, 13 Zod schemas + JSON Schema exports
  (`packages/core/src/schemas`), `LLMClient` (Meta Model API, 429 backoff,
  $3/run budget → exit 7, contributor gate), `FakeLLM`, validate-pack.
  Deps added, exact-pinned: `zod-to-json-schema@3.24.1` (ISC, permissive;
  3.25.x targets Zod v4 and breaks on pinned zod 3.23.8),
  root `eslint@8.57.1` + `@typescript-eslint/*@7.18.0` (MIT; required by
  every package lint script/.eslintrc, was missing).
- **S1 init** — installs pack to `.agents/skills` + `.claude/skills`,
  AGENTS.md pointer, `--dry-run`, SHA-256 hash-diff (no overwrite of user
  edits without `--force`), idempotent. 6 tests.
- **S2 detector** — deterministic pass + LLM fill-only-missing (injected
  client), `{value,source,confidence}` per field, 11 golden fixtures incl.
  injection fixture byte-identical to benign. 85 scan tests total.
- **S3 providers** — 5 registry YAMLs validated against Provider schema
  (AWS image-only per F2a), loader invariants, always-ask choice UX
  (AWS never preselected), injected bootstrap (absolute path, refuses
  project/node_modules binaries, credential-never-read proof). 32 tests.
- **S4 safe runner** — execa args-array only, per-provider allowlist,
  risk classes, sanitized PATH, redaction, append-only audit, red-team
  suite. 113 runner tests within core.
- **S5 deploy agent** — tool loop (7 tools), fetch_docs allowlist +
  labeled untrusted blocks, plan approval enforced before create/modify/
  delete dispatch, 3-retries-then-escalate, recipe replay, injection test.
  119 deploy tests total.
- **S6 build/domain/CI** — image-build, Registrar (Cloudflare) with typed
  price confirmation, domain command, deploy-on-merge workflow gen.
  Covered in deploy suite.
- **S7 scanner+brief** — project digest/SEO/brief (pre-existing, verified;
  85 scan tests with S2).
- **S8 market** — adapters, budget guard (unset → no paid calls +
  unknowns + enabling line), exact scoring formula, clustering. 25 tests.
- **S9/S9b/S9c plan** — archetype/channel ranking/backlog priority
  `(impact×confidence)/effort`, manifest capability validation, checklist,
  HQ CSV templates (5), directories vet/import/listing-kit. S9c Q7: list
  licenses unverifiable offline → **no rows copied**; importer + empty
  seed shipped (stop-and-ask item for owner, see below). 30 tests.
- **S10 composer** — template render, SKILL §1 inline, 4,000-word budget
  + appendix, deterministic, lint fail-closed (placeholders/secrets),
  third-party text only in labeled capped blocks, 9-archetype snapshots,
  injection test. 44 tests.
- **S11 gate UX** — ≤12-line summary, Execute/Edit/Quit, mocked
  clipboard/editor tests, `--yes`/`--json`, exits 3/6 per §2.5. CLI 55.
- **S12 MCP** — stdio server, 3 read + 3 write tools; write tools act
  only with `confirm:true` (proven by call counts + in-memory client
  test). SDK pinned `@modelcontextprotocol/sdk@1.17.0`; this package
  uses `zod@3.25.76` because SDK 1.17 requires the `zod/v3` subpath.
- **S13 evals** — detector harness 30/30, rubric.md, deploy-gym.md,
  scoreboard.md. CI never gated on a live LLM.
- **S14 docs** — README 5-command quickstart, CONTRIBUTING, SECURITY
  (threat model incl. trusted-CLI assumption), PRIVACY (egress table,
  Meta terms linked, not paraphrased).
- **S15** — SPEC §10 only. No code, as specified.

### Addendum 2026-10-29 — Modal + Cloudflare Workers, E2E run

- New providers: `providers/modal.yaml` (Modal CLI: `modal deploy` create,
  `modal token new` login, `modal profile current` verify) and
  `providers/cloudflare-workers.yaml` (Workers-only wrangler patterns,
  distinct from Pages-focused `cloudflare`). Registry now 7 providers.
- Choice UX: Python/GPU serverless → Modal preselected; small edge JS/TS
  (no DB) → Cloudflare Workers preselected; AWS still never preselected.
- Tests: 549 green (deploy 133, +14). New `evals/e2e-local.mjs` harness
  (detect → registry/choice → allowlist → plan → gate → MCP handlers):
  18/18 PASS. Detector evals 30/30. Live smokes: `init` into temp dir
  (19 written, second run 0), `validate-pack` ok, MCP stdio `initialize`
  handshake ok. No real provider accounts used; deploys remain
  plan-approved through the runner.

### Addendum 2026-10-29 — Tenant subdomains (kailashe.tech), Graphify, hosting flow

- **Flow** (owner-directed): Kailashe reads the project first (detector +
  project graph), then: if the project fits Vercel, Vercel is offered and a
  Vercel deploy **uses the Vercel domain itself — the domain step is
  skipped**. Otherwise the user picks a host (Workers/Modal/Fly/…, logging in
  with that provider's own CLI; Kailashe never takes provider credentials)
  and only then is asked "Do you have a domain?": yes → printed DNS settings
  (apex + www CNAMEs); no → pick a label, e.g. `zi1`, and
  `zi1.kailashe.tech` is claimed: CNAME to the deployed host, HTTPS on.
  Labels are globally unique, claimable once ever (tombstone keeps them
  bound to the first owner after release), one active label per user.
- **deploy/tenancy.ts**: platform domain `KAILASHE_PLATFORM_DOMAIN` (default
  `kailashe.tech`), label validation + reserved list, `TenantRegistry`
  (in-memory + file `.kailashe/tenants.json`, tmp+rename, corrupt file
  refuses), DNS providers behind one interface: `CloudflareDnsProvider`
  (proxied CNAME, Universal SSL), new `VercelDnsProvider` (Vercel DNS,
  automatic TLS; no update endpoint → delete+recreate), `FakeDnsProvider`.
  Claim happens before DNS writes; DNS failure rolls the claim back.
  Tokens come only from env and never appear in errors/logs. CLI refuses to
  claim (exit 3, nothing recorded) when tenant DNS is not configured.
- **deploy/hosting-flow.ts**: `assessVercelFit` (native frameworks +
  static eligible; container images, GPU, Python servers, long-running
  servers blocked with reasons; database stays an external-DB note) and
  `resolveHostingFlow` composing offer-vercel → use-provider-domain
  (Vercel) → ask-domain → custom settings / claim-subdomain / needs-label.
- **Graphify integration** (owner-directed; Graphify-Labs/graphify):
  research found PyPI `graphifyy` 0.9.97, Apache-2.0, Python ≥3.10, and —
  decisive — **no non-interactive build subcommand**: graphs are built by
  its assistant skill (`/graphify .`) into `graphify-out/graph.json`
  (NetworkX node-link). So Graphify is an **optional user-installed
  external tool** (same trust model as provider CLIs), NOT a Kailashe
  dependency: `packages/scan/src/graphify.ts` only reads that file
  (tolerant Zod at the boundary; corrupt file = loud error), summarizes it
  (god nodes, file types, EXTRACTED share), and prints the pinned setup
  commands (`pipx install graphifyy==0.9.97`). `packages/scan/src/graph.ts`
  is the built-in fallback graph (files/dirs/packages/import edges,
  deterministic, bounded, reads import specifiers only). Dependency
  justification per AGENTS.md: license Apache-2.0 (permissive), actively
  released (0.9.x), heavy Python/tree-sitter footprint — hence optional and
  never bundled or auto-installed. `skill/` pack unchanged (follow-up task
  if the operator flow should name Graphify explicitly).
- **CLI**: new `kailashe graph [dir] [--json]` (profile + graph + Vercel
  fit + next step) and `kailashe domain setup|check|custom|release`
  (`setup` asks "Do you have a domain?" interactively on a TTY;
  `--provider vercel` skips the domain step). CLI now depends on the
  workspace packages `@kailashe/deploy` and `@kailashe/scan`;
  `@kailashe/deploy` gained `main`/`types`/`exports` so it resolves.
- **Tests**: 609 green (deploy 170 incl. 29 tenancy + 8 hosting-flow; scan
  92 incl. graph/graphify; cli 71 incl. 11 domain-tenancy + 5 graph).
  `evals/e2e-local.mjs` extended: 27/27 PASS. Live smokes: `graph` on a
  Next.js fixture → offer-Vercel; `domain setup --provider vercel` →
  Vercel domain, exit 0; `domain custom` → CNAME settings; claim without
  operator DNS env → exit 3, no claim. Real Cloudflare/Vercel DNS writes
  still never made (no accounts) — providers are mocked-fetch tested.
- **Graphify, live run**: `graphifyy==0.9.97` installed in an isolated
  temp venv (uv; nothing added to the system or the repo) and run over
  this repo via the committed `evals/graphify-build.py` (structural AST
  extraction only — the skill's LLM semantic pass is not replicated):
  189 code files → 2,350 nodes, 4,008 edges, 146 communities in
  `graphify-out/graph.json` (1.7 MB, gitignored). `kailashe graph .` reads
  it back as source "graphify" (100% EXTRACTED relations; top concepts:
  plan/src/index.ts, cli gate, tenancy.ts, detect.ts). Detector notes for
  the monorepo root itself: appType "unknown" (workspace root, correct —
  not a deployable app).

### Open items for owner (gates, per build prompt)
- **G1–G4 human reviews** not yet signed off (code complete; review pending).
- **S9c Q7**: verify ai-directories / OpenLaunch LICENSEs online; if
  permissive, import rows with attribution + `THIRD_PARTY.md`.
- **S5 start-of-slice re-verification** of AWS ECS Express Mode CLI verbs
  against live AWS docs (offline here; allowlist follows SPEC F2a).
- **E2E** (`pnpm test:e2e`, `KAILASHE_E2E=1`, real accounts) never run.

### 2026-10-29 — Addendum: static-shell detector fix + Modal CLI machine fix

- **Detector (packages/scan)**: an Express/Fastify server whose entry only
  mounts the bundler build output (`express.static`, `@fastify/static`,
  `sendFile`) is now classified `rendering: static` / `artifactKind:
  build-dir` with an explanatory note, when a bundler config and a build
  script also exist and no database dependency is present. A real
  DB-backed or route-only API stays `dynamic`. New unit tests cover both
  shapes; golden fixtures and the 30-case detector eval unchanged (30/30).
- **Hosting flow (packages/deploy)**: `assessVercelFit` no longer blocks a
  long-running app type when rendering is static; it offers Vercel with a
  note that stateless API routes must be ported to serverless functions
  and stateful/long-lived work still needs a server host.
- **Proof on a real project**: `kailashe graph .` on the user's
  portfolio-website-master now prints "Vercel fit: YES" (was NO —
  Express false negative). Full gate green: 641 tests across 8 packages,
  typecheck + lint clean.
- **Modal CLI (machine, not repo)**: the stale `A:\conda\Scripts\modal.exe`
  shim (package missing → `ModuleNotFoundError`) was renamed to
  `modal.exe.stale-backup`; `modal` now resolves to the uv-tool install
  (`C:\Users\Shivam\.local\bin\modal.exe`, client 1.6.3, `--version`
  exit 0). Login is still the operator's own step (`modal setup`).

### 2026-10-29 — Addendum: manual custom-domain step completed

- **Tenancy (packages/deploy)**: `customDomainSettings` now includes the
  step end users must do themselves — register the domain (and its `www`
  host) in their hosting provider's custom-domain settings. DNS alone is
  not enough: providers answer only for names they know (verified live
  against Modal — a foreign `Host` returns 404 and no certificate is
  issued). Decision by the owner: end users take care of their own domain
  manually; Kailashe prints the complete settings and does not perform
  this step. Test locks the step wording in.

### 2026-11-01 — S16: `kailashe deploy` to kailashe.com (branch slice/s16-kailashe-com-deploy)

- **Contract**: read https://www.kailashe.com/for-agents.md in full
  (skill_version 7cc156a4ed04) and the platform MCP tool schemas. The
  integration uses the documented agent route — remote MCP over
  streamable HTTP at `$BASE/mcp` with a personal Bearer token
  (`KAILASHE_TOKEN`, falling back to the legacy `ARTIFACT_HUB_TOKEN`
  name) — instead of ad-hoc upload scripts, exactly as the guide
  prescribes for MCP-capable agents. One deliberate deviation: the
  guide's token *files* (`~/.config/kailashe/tokens/…`) are never read,
  per this repo's "never read provider credential files" rule; the
  environment variable is the only credential source.
- **New module** `packages/deploy/src/kailashe-com.ts` (no new
  dependencies — built-in fetch + existing Zod): static-fit assessment
  (dynamic/server/non-HTML projects are refused), static-tree collector
  enforcing platform limits (root `index.html` required; 2000 files /
  300 MB / 250 MB per file; `node_modules`, `.git` and dot-paths are
  skipped and reported, which also keeps `.kailashe/` state out of
  redeploys), and an MCP client (`kailashe_connection` identity check
  first, inline `kailashe_publish` for small sites,
  `kailashe_upload_start`/`kailashe_upload_write` 256 KiB chunks +
  publish-by-`upload_id` above ~1.5 MB; explicit `slug` provisions
  `https://<slug>.kailashe.com`; share policy always sent explicitly;
  deterministic content-hash `operation_key` so a retry recovers the
  same publication instead of creating a copy). Every response is
  Zod-validated; 401/403 map to an auth error; tokens only ever appear
  in the Authorization header.
- **CLI**: new `kailashe deploy [dir] --label <label> [--title] [--base]
  [--share public|login|none] [--json]`. Flow: detect → static fit
  (refusal prints "The website is not fit for Kailashe at the moment.
  Please stick around as we add more features to it.", exit 6, before
  any network) → label (flag or TTY prompt; exit 3 without one) → token
  (exit 4 without `KAILASHE_TOKEN`) → publish → record
  `.kailashe/deploy-state.json` (DeployState schema, live URL as the
  production address; no secrets) → unauthenticated verification of the
  live subdomain (3 tries; unverified is exit 5 but keeps the state).
  Output ends with the share link ("Share this link: …") and the next
  operator-loop steps naming the live URL for business-plan.md and
  prompt.md.
- **Tests**: 630 green workspace-wide (deploy 182 incl. 11 new
  kailashe-com tests over a fake MCP endpoint; cli 78 incl. 7 new
  deploy tests with fake client/detector — no network). Typecheck +
  lint clean. Live smokes on this machine: `deploy` on the vCard static
  site reaches the token gate (exit 4, no token set); `deploy` on the
  Express portfolio prints the not-fit message (exit 6). **The real
  publish is pending the owner's `KAILASHE_TOKEN`** (personal token set
  in their own terminal — credentials are never pasted into chat).

### 2026-11-01 — S16 addendum: login-first publish route + live deploy

- **Login-first route (owner-directed)**: without `KAILASHE_TOKEN`, deploy
  now publishes through the official platform CLI's stored login instead
  of demanding a token: `kailashe --json whoami` → `kailashe login` (only
  when signed out, run with inherited stdio via the new SafeRunner
  `stdio: "inherit"` option) → `kailashe --json publish`. New module
  `packages/deploy/src/platform-cli.ts` + `providers/kailashe-com.yaml`
  register the `kailashe-com` provider; all subprocess calls go through
  the core SafeRunner with that allowlist (whoami read, login
  iam-billing-network, publish create). This allowlist addition was
  authorized by the owner's explicit instruction to "check if cli is
  login if not run the command for login". The CLI's token file is read
  only by that CLI — Kailashe never reads it. `KAILASHE_TOKEN` still
  selects the MCP route. On Windows the allowlist targets `kailashe.cmd`
  (the bare name is an unspawnable sh shim).
- **Gate**: 642 tests green workspace-wide (deploy 192 incl. 10 new
  platform-cli tests over a fake runner; cli 79; core 167 incl. the new
  inherited-stdio test). Typecheck + lint clean.
- **Live deploy (the acceptance test)**: `kailashe deploy "New
  folder\vcard-personal-portfolio-master" --label bcard` → exit 0:
  Live https://bcard.kailashe.com · share link
  https://www.kailashe.com/v/XByRxYSowMfqQBja_WYXcEXr-b72cBE4 ·
  published under the CLI's stored login · 41 files, 1,248,907 bytes ·
  2 hidden paths skipped · state recorded in the site's
  `.kailashe/deploy-state.json`. Independently verified: live URL 200,
  share link 200, served HTML is the vCard page.
- **Post-deploy step**: `business-plan.md`, `prompt.md` (3,142 words)
  and `appendix-01.md` generated in the vCard folder from the plan +
  compose pipeline (archetype content-media), with
  https://bcard.kailashe.com as the production address read from
  deploy-state.json; `kailashe gate prompt.md --yes --json` passes
  (exit 0). No secrets in any generated file (token mentions are
  template boilerplate only).

### 2026-11-01 — S16 follow-up: one-command flow (`kailashe-cloud deploy`)

- **End-to-end deploy**: `kailashe deploy` now finishes the operator
  loop in the same run — after the publish verifies, it generates
  `business-plan.md` + `prompt.md` (deterministic plan/compose, facts
  sourced from README/package.json/index.html, unknowns listed, live
  URL as the production address) via new
  `packages/cli/src/commands/post-deploy.ts`. `--no-plan` opts out; a
  generation failure warns but never fails a live deploy.
- **Package renamed** `@kailashe/cli` → `kailashe-cloud` (bin
  `kailashe-cloud`): the old name collided with the official platform
  package `@kailashe/cli` — a global `npm link` of ours replaced the
  platform CLI's global install on this machine (restored with
  `npm install -g @kailashe/cli`; verified signed-in after). With
  distinct names, `cd packages/cli && npm link` puts `kailashe-cloud`
  on PATH alongside the platform's `kailashe`. Verified from a foreign
  folder: `--version` 0.1.0, dynamic fixture deploy → not-fit exit 6
  with no files written, platform `whoami` still `ok`.
- User flow is now: clone → `pnpm install` → `pnpm build` → `npm link`
  (in packages/cli) → `cd <project>` → `kailashe-cloud deploy`.
  Recording steps updated in `New folder/VCARD-RECORDING-STEPS.md`.
  Gate: 646 tests green (cli 83, +4), typecheck + lint clean.

<!-- Slice reports appended per Appendix B after each slice -->
