# Kailashe

Open source (MIT) CLI, stdio MCP server, and skill pack that takes an AI-built project from "runs locally" to "live URL" — and then operates it as a side business: market research, an archetype plan, a backlog, a tool manifest, and a composed `prompt.md` for Muse.

Kailashe never handles provider credentials. Deploys run through each provider's own CLI (AWS, DigitalOcean, Vercel, Cloudflare Pages, Cloudflare Workers, Fly, Modal) on your own logged-in account, behind an allowlisted, redacting, audit-logged runner. See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).

Spec: [docs/SPEC.md](docs/SPEC.md) · Tasks: [TASKS.md](TASKS.md) · Skill pack: [skill/kailashe-operator](skill/kailashe-operator)

## Commands

```sh
git clone https://github.com/Shvmshrd/kailashe-cloud.git
cd kailashe-cloud
pnpm install && pnpm build
cd packages/cli && npm link && cd ../..   # one-time: puts `kailashe-cloud` on your PATH

cd ../your-static-site
kailashe-cloud deploy        # publish → live URL, then write business-plan.md + prompt.md
kailashe-cloud gate prompt.md
```

Other commands: `kailashe-cloud init` (install the operator skill pack), `doctor`, `validate-pack`, `graph` (read + graph the project, show the first hosting step), `domain` (tenant subdomain claims).

### Deploying a static site to kailashe.com

`kailashe deploy` publishes a **static HTML site** to the hosted
[kailashe.com](https://www.kailashe.com) platform and returns the live
address you selected: `https://<label>.kailashe.com`. There is no build
step — the folder is uploaded as-is, so publish your build output folder
(`dist/`, `public/`, …) or any folder with an `index.html` at its root.

```sh
# one-time: install the platform CLI and sign in once in your browser
# (Kailashe runs `kailashe login` for you if you are signed out)
npm install -g @kailashe/cli

cd your-static-site
kailashe-cloud deploy                    # asks for the label → https://<label>.kailashe.com
kailashe-cloud deploy --label bcard      # or pass it directly
kailashe-cloud deploy --label bcard --share none --no-plan --json
```

No token handling is needed for the default route: deploy checks the
platform CLI's login (`kailashe whoami`), runs `kailashe login` if you
are signed out, and publishes through that stored login — the token file
is read only by that CLI, never by Kailashe. If you prefer, set
`KAILASHE_TOKEN` in your own terminal instead and the same command
publishes over the platform's MCP endpoint with that token (sent only as
a bearer header, never logged or written to disk).

Dynamic projects (server apps, APIs, anything that is not static HTML)
are refused with *"The website is not fit for Kailashe at the moment.
Please stick around as we add more features to it."* (exit 6) — host
those on a provider below instead. A successful deploy is recorded in
`.kailashe/deploy-state.json`, and the same run then generates
`business-plan.md` and a composed `prompt.md` for Muse in the project
folder — both addressed at the live URL it just created (`--no-plan`
skips this). Finish with `kailashe-cloud gate prompt.md`.

For non-static projects, the provider hosting flow (`kailashe-cloud graph` shows the first step) asks which provider to use (it preselects one with a reason; AWS is never preselected), shows an exact plan — resources, commands, monthly cost, rollback — and runs nothing create/modify/delete until you approve.

### How a deploy gets its domain

Kailashe first reads your project (`kailashe-cloud graph`) — detector profile plus a project graph. For the richest graph it can read [Graphify](https://github.com/Graphify-Labs/graphify) output (optional, Apache-2.0, user-installed: `pipx install graphifyy==0.9.97`, `graphify install`, then `/graphify .` in Claude Code writes `graphify-out/graph.json`); without it, a built-in graph of files/packages/imports is used.

Then the flow is:

1. **If the project fits Vercel** (Next.js and other SSR/static front ends), Kailashe offers Vercel first. A Vercel deploy **uses the Vercel domain itself** (`*.vercel.app`) — there is no domain step at all.
2. **Any other host** (Cloudflare Workers, Modal, Fly, DigitalOcean, … — you log in with that provider's own CLI; Kailashe never takes provider credentials): only now does Kailashe ask *"Do you have a domain?"*
   - **Yes** → Kailashe prints the exact DNS settings (apex + `www` CNAMEs to your deployed host) for you to add at your registrar.
   - **No** → pick a label, e.g. `zi1`, and Kailashe claims `zi1.kailashe.tech` for you: a CNAME to your deployed host with HTTPS on (Cloudflare-proxied Universal SSL, or Vercel DNS automatic TLS, depending on where the `kailashe.tech` zone is hosted). Every label is **globally unique and can be claimed only once** — it stays bound to its first user even after release, and each user holds one active label at a time.

```sh
kailashe-cloud domain setup --provider vercel --target my-app.vercel.app   # Vercel: uses the Vercel domain
kailashe-cloud domain setup --label zi1 --target my-app.modal.run --user u1 # claim zi1.kailashe.tech
kailashe-cloud domain check zi1                                             # is the label still free?
kailashe-cloud domain custom mysite.com --target my-app.modal.run          # your domain: DNS settings
kailashe-cloud domain release zi1 --user u1                                 # release (label stays yours)
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
