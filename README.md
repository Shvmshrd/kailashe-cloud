# Kailashe

Open source (MIT) CLI, stdio MCP server, and skill pack that takes an AI-built project from "runs locally" to "live URL" — and then operates it as a side business: market research, an archetype plan, a backlog, a tool manifest, and a composed `prompt.md` for Muse.

Kailashe never handles provider credentials. Deploys run through each provider's own CLI (AWS, DigitalOcean, Vercel, Cloudflare Pages, Cloudflare Workers, Fly, Modal) on your own logged-in account, behind an allowlisted, redacting, audit-logged runner. See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).

Spec: [docs/SPEC.md](docs/SPEC.md) · Tasks: [TASKS.md](TASKS.md) · Skill pack: [skill/kailashe-operator](skill/kailashe-operator)

## Commands

```sh
npx kailashe init          # install the operator skill pack (.agents/skills + .claude/skills)
npx kailashe doctor        # check node, provider CLIs, env
npx kailashe validate-pack # validate the skill pack (also runs in CI)
npx kailashe graph         # read + graph the project, show the first hosting step
# copy .env.example to .env and set MODEL_API_KEY
npx kailashe deploy . --label bcard   # static sites: publish to kailashe.com → https://bcard.kailashe.com
npx kailashe operate       # scan → market → plan → prompt.md gate (Execute / Edit / Quit)
```

### Deploying a static site to kailashe.com

`kailashe deploy` publishes a **static HTML site** to the hosted
[kailashe.com](https://www.kailashe.com) platform and returns the live
address you selected: `https://<label>.kailashe.com`. There is no build
step — the folder is uploaded as-is, so publish your build output folder
(`dist/`, `public/`, …) or any folder with an `index.html` at its root.

```sh
# one-time: create a personal token in your kailashe.com account, then
# set it in your own terminal (never commit it, never paste it into chat)
export KAILASHE_TOKEN=…          # PowerShell: $env:KAILASHE_TOKEN = "…"
npx kailashe deploy ./dist --label bcard        # → https://bcard.kailashe.com
npx kailashe deploy .                           # asks for the label interactively
npx kailashe deploy ./dist --label bcard --share none --json
```

Dynamic projects (server apps, APIs, anything that is not static HTML)
are refused with *"The website is not fit for Kailashe at the moment.
Please stick around as we add more features to it."* (exit 6) — host
those on a provider below instead. A successful deploy is recorded in
`.kailashe/deploy-state.json`; the business-plan and prompt steps that
follow read the production URL from there. Publishing uses the
platform's MCP endpoint (`KAILASHE_TOKEN`, or `KAILASHE_BASE_URL` for a
self-hosted deployment); the token is sent only as a bearer header and
is never logged or written to disk.

`deploy` always asks which provider to use (it preselects one with a reason; AWS is never preselected), shows an exact plan — resources, commands, monthly cost, rollback — and runs nothing create/modify/delete until you approve.

### How a deploy gets its domain

Kailashe first reads your project (`kailashe graph`) — detector profile plus a project graph. For the richest graph it can read [Graphify](https://github.com/Graphify-Labs/graphify) output (optional, Apache-2.0, user-installed: `pipx install graphifyy==0.9.97`, `graphify install`, then `/graphify .` in Claude Code writes `graphify-out/graph.json`); without it, a built-in graph of files/packages/imports is used.

Then the flow is:

1. **If the project fits Vercel** (Next.js and other SSR/static front ends), Kailashe offers Vercel first. A Vercel deploy **uses the Vercel domain itself** (`*.vercel.app`) — there is no domain step at all.
2. **Any other host** (Cloudflare Workers, Modal, Fly, DigitalOcean, … — you log in with that provider's own CLI; Kailashe never takes provider credentials): only now does Kailashe ask *"Do you have a domain?"*
   - **Yes** → Kailashe prints the exact DNS settings (apex + `www` CNAMEs to your deployed host) for you to add at your registrar.
   - **No** → pick a label, e.g. `zi1`, and Kailashe claims `zi1.kailashe.tech` for you: a CNAME to your deployed host with HTTPS on (Cloudflare-proxied Universal SSL, or Vercel DNS automatic TLS, depending on where the `kailashe.tech` zone is hosted). Every label is **globally unique and can be claimed only once** — it stays bound to its first user even after release, and each user holds one active label at a time.

```sh
npx kailashe domain setup --provider vercel --target my-app.vercel.app   # Vercel: uses the Vercel domain
npx kailashe domain setup --label zi1 --target my-app.modal.run --user u1 # claim zi1.kailashe.tech
npx kailashe domain check zi1                                             # is the label still free?
npx kailashe domain custom mysite.com --target my-app.modal.run          # your domain: DNS settings
npx kailashe domain release zi1 --user u1                                 # release (label stays yours)
```

Tenant DNS writes need operator configuration the user never sees: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID`, or `VERCEL_API_TOKEN` if the `kailashe.tech` zone uses Vercel DNS. Without them, claims stop with exit 3 and nothing is claimed. `KAILASHE_PLATFORM_DOMAIN` overrides the platform domain (`kailashe.tech`). Claims persist in `.kailashe/tenants.json`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | unexpected error |
| 2 | usage error (bad flags/args) |
| 3 | needs input, or approval denied |
| 4 | provider auth failed |
| 5 | deploy failed or partial |
| 6 | validation failed |
| 7 | budget exceeded |
| 130 | interrupted (SIGINT) |

## Configuration

Copy `.env.example` to `.env`. Key settings: `MODEL_API_KEY`, `KAILASHE_MODEL` (default `muse-spark-1.3`), `KAILASHE_LLM_BASE_URL` (default `https://api.meta.ai/v1`; any OpenAI-compatible endpoint works), `KAILASHE_MODEL_BUDGET_USD` (default 3 per run), `KAILASHE_MARKET_BUDGET_USD` (no paid market calls while unset). Contributor-tier models (`*-contributor`) are refused unless `KAILASHE_ALLOW_CONTRIBUTOR_TIER=1` — see [PRIVACY.md](PRIVACY.md).

## MCP server

`packages/mcp` exposes a stdio MCP server: read tools `detect_project`, `list_providers`, `status`; write tools `deploy`, `scan_business`, `build_prompt` require explicit confirmation.

## Development

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

`pnpm test:e2e` needs `KAILASHE_E2E=1` and real accounts; never run in CI. Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
