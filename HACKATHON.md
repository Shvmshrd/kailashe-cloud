# Kailashe — before & during the hackathon

## Before the hackathon: the publishing platform (kailashe.com)

Kailashe.com already existed as hosted publishing infrastructure
for sites:

- **Hosted publishing** — upload a folder and get a live site at
  `https://<name>.kailashe.com`, plus public share links, version
  history, rollback, and comments.
- **Kailashe MCP** — a remote MCP server (27 tools: publish, update,
  edit, share, claim, fork, export, rollback, …) so any AI agent can
  publish and manage sites programmatically.
- **Kailashe CLI** (`@kailashe/cli`, command: `kailashe`) — sign in once
  in the browser, then `kailashe publish <folder>` from the terminal.
- **An agent contract** (`/for-agents.md`) describing exactly how
  agents should publish, verify, and hand over sites.

In short: before the hackathon, Kailashe could *put a site on the
internet*. It still needed a human operator to do everything after
that.

## During the hackathon: Kailashe Cloud — deploy, then run the business

This repo connects the platform to Muse and closes the loop from
"a folder on your disk" to "a business being operated".

### One command: `kailashe-cloud deploy`

From inside any project folder, one command now:

1. **Reads the project** — a deterministic detector (plus an optional
   Graphify code graph) decides what the project is. Projects that
   need a server runtime get a clear not-yet message instead of a
   broken deploy.
2. **Deploys it** — through your existing platform login (or an MCP
   token), behind an allowlisted, redacting, audit-logged runner.
   You pick the label; the site goes live at
   `https://<label>.kailashe.com` and is verified before the command
   returns. No credential file is ever read by Kailashe.
3. **Generates the business** — the same run writes `business-plan.md`
   (archetype plan, ranked channels, KPIs, backlog, unknowns — every
   claim sourced from the project's own files) and `prompt.md`, a
   composed operator prompt addressed at the live URL.

### The Muse connection: everything after deploy

`prompt.md` is where Kailashe hands over to Muse. Pasted into Muse
(after `kailashe-cloud gate prompt.md` validates it — sections, size,
no secrets), the prompt turns Muse into the site's operator:

- **Market & GTM** — research the niche, rank the channels for the
  business archetype, work a prioritised backlog with KPIs and
  stop-rules.
- **Content engine** — pillar pages, a publishing calendar, and
  repurposing flows that all point back at the live site.
- **Support** — an inbox/support loop with drafted replies; nothing is
  sent without the owner's approval.
- **Payments** — wire up checkout/payment links through approved
  connectors when the business is ready to charge; never spend or
  charge without explicit approval.
- **Operations** — a Project HQ, scheduled weekly tasks and reports,
  so the business keeps running after the first session ends.

The safety model carries through: secrets never enter files or chats,
third-party text is treated as data, unknown facts are listed as
unknowns — never invented.

### Also built during the hackathon

- Multi-provider hosting flow (Vercel-first; Cloudflare, Modal, Fly,
  DigitalOcean, AWS) for projects that need a server runtime.
- Tenant subdomains on `kailashe.tech` (claim-once, globally unique)
  and bring-your-own-domain DNS guidance.
- A stdio MCP server exposing Kailashe's own tools, a skill pack for
  Claude, detector/graphify evals, and a 646-test suite.

### Proof

- Live demo site: https://bcard.kailashe.com — deployed with
  `kailashe-cloud deploy`, business plan + prompt generated in the
  same run.
- This repo: https://github.com/Shvmshrd/kailashe-cloud
