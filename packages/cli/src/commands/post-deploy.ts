/**
 * Post-deploy artifacts: after a successful publish, turn the deployed
 * project into the operator loop's starting documents — `business-plan.md`
 * and a composed `prompt.md` for Muse — using the live production URL.
 *
 * Everything here is deterministic (plan package hint scoring, no LLM) and
 * offline: facts come only from the project's own files (README, package
 * metadata, index.html), each claim carries its source, and anything not
 * found in the files is listed under Unknowns instead of being invented.
 */

import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { planSync, selectArchetype, sortByPriority } from "@kailashe/plan";
import { compose, type ComposeInput } from "@kailashe/compose";
import type { DetectedProfile } from "@kailashe/scan";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateArtifactsInput {
  /** Project directory the artifacts are written into. */
  dir: string;
  /** Subdomain label the site was published under. */
  slug: string;
  /** Live production URL, e.g. https://bcard.kailashe.com. */
  liveUrl: string;
  shareUrl: string | null;
  profile: DetectedProfile;
  now?: Date;
}

export interface PostDeployArtifacts {
  businessPlanFile: string;
  promptFile: string;
  appendixFiles: string[];
  archetype: string;
}

interface ProjectFacts {
  name: string;
  what: string;
  features: string[];
  keywords: string[];
}

// ---------------------------------------------------------------------------
// Fact gathering — the project's own files only, everything capped
// ---------------------------------------------------------------------------

async function readTextSafe(dir: string, name: string): Promise<string | null> {
  try {
    return await readFile(path.join(dir, name), "utf8");
  } catch {
    return null;
  }
}

function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstParagraph(markdown: string): string | null {
  for (const block of markdown.split(/\n\s*\n/)) {
    const cleaned = stripMarkdown(block);
    if (cleaned.length >= 40) return cleaned.slice(0, 600);
  }
  return null;
}

function htmlTitle(html: string): string | null {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 120) : null;
}

function htmlHeadings(html: string): string[] {
  const found: string[] = [];
  const pattern = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null && found.length < 8) {
    const text = (match[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length >= 2 && !found.includes(text)) found.push(text.slice(0, 80));
  }
  return found;
}

function keywordsFrom(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
  return [...new Set(words)].slice(0, 20);
}

async function gatherFacts(input: GenerateArtifactsInput): Promise<ProjectFacts> {
  const readme = await readTextSafe(input.dir, "README.md");
  const indexHtml = (await readTextSafe(input.dir, "index.html")) ?? "";
  const pkgRaw = await readTextSafe(input.dir, "package.json");

  let pkgName: string | null = null;
  let pkgDescription: string | null = null;
  if (pkgRaw !== null) {
    try {
      const pkg = JSON.parse(pkgRaw) as { name?: unknown; description?: unknown };
      if (typeof pkg.name === "string" && pkg.name.trim() !== "") pkgName = pkg.name.trim();
      if (typeof pkg.description === "string" && pkg.description.trim() !== "") {
        pkgDescription = pkg.description.trim().slice(0, 300);
      }
    } catch {
      /* a malformed package.json contributes no facts */
    }
  }

  const title = htmlTitle(indexHtml);
  const name = pkgName ?? title ?? input.slug;
  const readmeLead = readme !== null ? firstParagraph(readme) : null;
  const headings = htmlHeadings(indexHtml);

  const what =
    readmeLead !== null
      ? `${readmeLead} (source: README.md)`
      : pkgDescription !== null
        ? `${pkgDescription} (source: package.json)`
        : title !== null
          ? `Static website titled "${title}" (source: index.html <title>), published as-is from this folder.`
          : "Static website published as-is from this folder (source: project files).";

  const features =
    headings.length > 0
      ? headings.map((h) => `${h} (source: index.html headings)`)
      : ["Home page served from index.html (source: project files)"];

  return {
    name,
    what,
    features,
    keywords: keywordsFrom(`${name} ${title ?? ""} ${readmeLead ?? ""}`),
  };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export async function generatePostDeployArtifacts(
  input: GenerateArtifactsInput,
): Promise<PostDeployArtifacts> {
  const facts = await gatherFacts(input);
  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  const appType = input.profile.appType.value;

  const unknowns = [
    "Owner's name, contact email and timezone (not present in the project files).",
    "Pricing: nothing in the project files states prices — confirm with the owner before stating any.",
    "Which page content is final vs placeholder/demo text — confirm with the owner.",
    "No analytics or conversion tracking verified on the site yet.",
    "No paid market research pulled (KAILASHE_MARKET_BUDGET_USD unset): channel ranking uses archetype defaults, not measured demand.",
    "Custom domain plans (the kailashe.com subdomain is the production address for now).",
  ];

  // Deterministic archetype pick (hint scoring; no LLM, no network).
  const selected = await selectArchetype({
    appType,
    keywords: [appType, ...facts.keywords],
  });

  const result = planSync({
    profile: { appType, keywords: facts.keywords },
    brief: {
      what: facts.what,
      audience: `People who find or are sent to ${input.liveUrl} — exact segments unconfirmed (see Unknowns).`,
      problem:
        "The site is live but undiscovered: without ranked channels, a backlog and a repeatable operating prompt, a published page gets no compounding traffic or enquiries.",
      features: facts.features,
      pricing: "Unknown — no pricing found in the project files.",
      links: [input.liveUrl],
    },
    market: { unknowns },
    archetypeOverride: selected.id,
    projectSlug: input.slug,
  });
  const { plan, backlog, manifest, checklist } = result;

  const brief: ComposeInput["brief"] = {
    what: facts.what,
    audience: `People who find or are sent to ${input.liveUrl} — exact segments unconfirmed (see Unknowns).`,
    problem:
      "The site is live but undiscovered: without ranked channels, a backlog and a repeatable operating prompt, a published page gets no compounding traffic or enquiries.",
    features: facts.features.join("; "),
    pricing:
      "Unknown — no pricing is published in the project files. Offer on enquiry only; never state a price the owner has not confirmed.",
    limits:
      "Static hosting (kailashe.com serves static files only): no server-side processing, so any form needs an external endpoint before it can deliver messages. No analytics verified yet. Content copied from a template or demo must be confirmed as real before it is promoted.",
    voice: "Clear, concise and specific. Short sentences, real details from the site, no hype.",
    donotsay:
      "Do not invent clients, employers, metrics, testimonials, prices, availability or results. Do not treat placeholder or demo content as real work until the owner confirms it.",
    links: `Production site: ${input.liveUrl}${input.shareUrl !== null ? ` · Share link: ${input.shareUrl}` : ""}`,
    owner: "Unknown — confirm the owner's name, contact and timezone (see Unknowns).",
  };

  const channelsTable = plan.channelsRankedJson
    .map((c, i) => `${i + 1}. ${c.channel} — ${c.why} (KPI: ${c.kpi}; stop if: ${c.stop_if})`)
    .join("\n");
  const kpiTable = plan.kpis.map((k) => `- ${k}`).join("\n");
  const topBacklog = sortByPriority(backlog).slice(0, 10);

  const businessPlan = `# Business plan — ${facts.name}

- Production address: ${input.liveUrl}
- Date: ${date}
- Archetype: ${selected.id} (${plan.archetypeName}) — ${selected.reason}

## What it is
${brief.what}

## Audience
${brief.audience}

## Problem
${brief.problem}

## Offer / features (verified from the project files)
${facts.features.map((f) => `- ${f}`).join("\n")}

## Pricing
${brief.pricing}

## 90-day goal
${plan.goal90d}

## KPIs
${kpiTable}

## Channels, ranked
${channelsTable}

## First tasks (top of the generated backlog)
${topBacklog.map((t, i) => `${i + 1}. ${t.title} [${t.channel}]`).join("\n")}

## Limits and risks
${brief.limits}

## Unknowns (never guess — confirm with the owner)
${unknowns.map((u) => `- ${u}`).join("\n")}

## Next actions
1. Confirm the Unknowns above with the owner and update this plan.
2. Run \`kailashe-cloud gate prompt.md\` and execute prompt.md in Muse.
3. Work the backlog top-down; re-check the KPIs weekly against ${input.liveUrl}.
`;

  const composeInput: ComposeInput = {
    project: {
      name: facts.name,
      url: input.liveUrl,
      repo: "local project folder (no git remote recorded)",
    },
    date,
    plan: { version: "1.0" },
    brief,
    market: {
      date,
      archetype: selected.id,
      archetype_reason: selected.reason,
      trends_table:
        "No paid market data pulled (KAILASHE_MARKET_BUDGET_USD unset) — archetype defaults used; see Unknowns.",
      clusters_table: "Not measured yet — see Unknowns.",
      gaps: "Unmeasured demand gaps — validate with the first content cycle before paid research.",
      competitors_table: "Not measured yet — see Unknowns.",
      communities_table: "Not measured yet — see Unknowns.",
      unknowns: unknowns.join("\n"),
      json_ref: "market.json not generated (no paid market budget set)",
    },
    goals: { ninety: plan.goal90d },
    kpi_table: kpiTable,
    channels_ranked: channelsTable,
    content_plan: `Content mix — bottom ${plan.contentMix.bottom}%, middle ${plan.contentMix.middle}%, top ${plan.contentMix.top}%, proof ${plan.contentMix.proof}%`,
    flows: plan.flows.join(", "),
    later_list:
      plan.later.map((l) => `${l.channel} (trigger: ${l.trigger})`).join("\n") || "None deferred.",
    checklist,
    tool_manifest_yaml: JSON.stringify(manifest, null, 2),
    hubs_in_use: plan.flows.join(", "),
    backlog_yaml: JSON.stringify(backlog, null, 2),
    owner: { tz: "unknown — confirm with owner", contact: "unknown — confirm with owner (see Unknowns)" },
    budget: {
      cap: "KAILASHE_MODEL_BUDGET_USD default $3 per run; no paid market budget set",
      paid: "Pre-approved spend: none. Ask before any paid tool, directory fee or ad spend.",
    },
    preapproved:
      "Publishing site updates to the production address, drafting content, and preparing (not sending) outreach.",
    never:
      "Never fabricate clients, metrics, testimonials, prices or availability. Never spend money without explicit approval. Never treat placeholder or demo content as real. Never collect personal data beyond what the site itself collects.",
    playbooks_included: plan.flows.join(", "),
  };

  const composed = compose(composeInput);

  const businessPlanFile = path.join(input.dir, "business-plan.md");
  const promptFile = path.join(input.dir, "prompt.md");
  await writeFile(businessPlanFile, businessPlan, "utf8");
  await writeFile(promptFile, composed.prompt, "utf8");
  const appendixFiles: string[] = [];
  for (const [name, content] of Object.entries(composed.appendix)) {
    const file = path.join(input.dir, name);
    await writeFile(file, content, "utf8");
    appendixFiles.push(file);
  }

  return { businessPlanFile, promptFile, appendixFiles, archetype: selected.id };
}
