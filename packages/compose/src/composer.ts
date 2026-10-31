import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ComposeInput, ComposeResult, ComposeOptions } from "./types.js";
import { WORD_BUDGET_DEFAULT } from "./types.js";
import { findPlaceholders, scanSecrets, wrapThirdPartyBlock } from "./lint.js";

// ---------------------------------------------------------------------------
// Boundary validation (AGENTS.md: Zod at every external boundary).
// Field-for-field mirror of @kailashe/core/schemas/compose-input (SPEC §6.12);
// kept local so compose has no new runtime dependency. Core is the schema of
// record — any drift here is a contract change and needs a schema task.
// ---------------------------------------------------------------------------

const s = z.string();
const s1 = z.string().min(1);

export const ComposeInputSchema = z
  .object({
    project: z.object({ name: s1, url: s, repo: s }).strict(),
    date: s,
    plan: z.object({ version: s }).strict(),
    brief: z
      .object({
        what: s, audience: s, problem: s, features: s, pricing: s,
        limits: s, voice: s, donotsay: s, links: s, owner: s,
      })
      .strict(),
    market: z
      .object({
        date: s, archetype: s, archetype_reason: s, trends_table: s, clusters_table: s,
        gaps: s, competitors_table: s, communities_table: s, unknowns: s, json_ref: s,
      })
      .strict(),
    goals: z.object({ ninety: s }).strict(),
    kpi_table: s,
    channels_ranked: s,
    content_plan: s,
    flows: s,
    later_list: s,
    checklist: s,
    tool_manifest_yaml: s,
    hubs_in_use: s,
    backlog_yaml: s,
    owner: z.object({ tz: s, contact: s }).strict(),
    budget: z.object({ cap: s, paid: s }).strict(),
    preapproved: s,
    never: s,
    playbooks_included: s,
  })
  .strict();

function parseComposeInput(input: ComposeInput): ComposeInput {
  try {
    return ComposeInputSchema.parse(input) as ComposeInput;
  } catch (e) {
    if (e instanceof z.ZodError) {
      // Paths and codes only — never echo input values (they may be secrets).
      const issues = e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`).join("; ");
      throw new Error(`invalid ComposeInput: ${issues}`);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

function defaultTemplatePath(): string {
  // packages/compose/src/composer.ts -> skill/kailashe-operator/assets/prompt.template.md
  // Resolve from package root regardless of cwd.
  const here = dirname(fileURLToPath(import.meta.url));
  // here = .../packages/compose/src  (in src) or .../packages/compose/dist (built)
  // Walk up to repo root: packages/compose -> packages -> repo
  const repoRoot = join(here, "..", "..", "..");
  return join(repoRoot, "skill", "kailashe-operator", "assets", "prompt.template.md");
}

function defaultSkillPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");
  return join(repoRoot, "skill", "kailashe-operator", "SKILL.md");
}

function defaultOpsLoopPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");
  return join(repoRoot, "skill", "kailashe-operator", "references", "ops-loop.md");
}

function loadTemplate(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  try {
    return readFileSync(defaultTemplatePath(), "utf8");
  } catch {
    return "";
  }
}

function loadSkillBody(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  try {
    const full = readFileSync(defaultSkillPath(), "utf8");
    return extractSkillBody(full);
  } catch {
    return "";
  }
}

/**
 * Remove the SKILL "Playbooks" section. The template instructs that it is
 * replaced by prompt section 9, which lists only the playbooks the plan uses.
 */
function stripPlaybooksSection(body: string): string {
  const start = body.indexOf("## Playbooks");
  if (start === -1) return body;
  const after = body.indexOf("\n## ", start + "## Playbooks".length);
  if (after === -1) return body.slice(0, start).trimEnd() + "\n";
  return body.slice(0, start) + body.slice(after + 1);
}

/**
 * Extract SKILL.md body from "Start of every session" to "Style of your output" inclusive.
 */
export function extractSkillBody(skillMd: string): string {
  const startMarker = "## Start of every session";
  const endMarker = "## Style of your output";
  const start = skillMd.indexOf(startMarker);
  const end = skillMd.indexOf(endMarker);
  if (start === -1 || end === -1) return stripPlaybooksSection(skillMd);
  // Include the end section header + its body until next ## or EOF
  const afterEnd = skillMd.indexOf("\n## ", end + endMarker.length);
  const body = afterEnd === -1 ? skillMd.slice(start) : skillMd.slice(start, afterEnd);
  return stripPlaybooksSection(body);
}

/**
 * Extract a numbered section (e.g. 1 or 7) from ops-loop.md, heading included,
 * up to the next `## ` heading or EOF.
 */
export function extractOpsLoopSection(opsLoopMd: string, section: 1 | 7): string {
  const marker = section === 1 ? "## 1. Project HQ" : "## 7. Weekly report";
  // Normalize line endings first: a CRLF checkout (Windows CI) must not
  // defeat the exact section-heading match below.
  const lines = opsLoopMd.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => l === marker);
  if (start === -1) return "";
  // A section ends at the next `## ` heading outside a code fence — the weekly
  // report template is fenced and itself contains `## ` lines.
  let inFence = false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.startsWith("```")) inFence = !inFence;
    else if (!inFence && line.startsWith("## ")) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").trim();
}

function loadOpsLoopSection(section: 1 | 7, explicit?: string): string {
  if (explicit !== undefined) return explicit;
  try {
    return extractOpsLoopSection(readFileSync(defaultOpsLoopPath(), "utf8"), section);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Placeholder replacement
// ---------------------------------------------------------------------------

/** Third-party market text enters the prompt only in a labeled, capped block (SPEC §4.3). */
function asDataBlock(label: string, value: string): string {
  if (!value.trim() || value.includes("<!-- BEGIN third-party data:")) return value;
  return wrapThirdPartyBlock(label, value);
}

/** Flat map of placeholder key -> value. */
function flattenInput(input: ComposeInput): Record<string, string> {
  return {
    "project.name": input.project.name,
    "project.url": input.project.url,
    "project.repo": input.project.repo,
    "date": input.date,
    "plan.version": input.plan.version,
    "brief.what": input.brief.what,
    "brief.audience": input.brief.audience,
    "brief.problem": input.brief.problem,
    "brief.features": input.brief.features,
    "brief.pricing": input.brief.pricing,
    "brief.limits": input.brief.limits,
    "brief.voice": input.brief.voice,
    "brief.donotsay": input.brief.donotsay,
    "brief.links": input.brief.links,
    "brief.owner": input.brief.owner,
    "market.date": input.market.date,
    "market.archetype": input.market.archetype,
    "market.archetype_reason": input.market.archetype_reason,
    "market.trends_table": asDataBlock("market.trends_table", input.market.trends_table),
    "market.clusters_table": asDataBlock("market.clusters_table", input.market.clusters_table),
    "market.gaps": asDataBlock("market.gaps", input.market.gaps),
    "market.competitors_table": asDataBlock("market.competitors_table", input.market.competitors_table),
    "market.communities_table": asDataBlock("market.communities_table", input.market.communities_table),
    "market.unknowns": input.market.unknowns,
    "market.json_ref": input.market.json_ref,
    "goals.ninety": input.goals.ninety,
    "kpi_table": input.kpi_table,
    "channels_ranked": input.channels_ranked,
    "content_plan": input.content_plan,
    "flows": input.flows,
    "later_list": input.later_list,
    "checklist": input.checklist,
    "tool_manifest_yaml": input.tool_manifest_yaml,
    "hubs_in_use": input.hubs_in_use,
    "backlog_yaml": input.backlog_yaml,
    "owner.tz": input.owner.tz,
    "owner.contact": input.owner.contact,
    "budget.cap": input.budget.cap,
    "budget.paid": input.budget.paid,
    "preapproved": input.preapproved,
    "never": input.never,
    "playbooks_included": input.playbooks_included,
  };
}

/**
 * Deterministic placeholder substitution: a single left-to-right pass, so a
 * value that itself contains "{{...}}" is inserted verbatim and never
 * rescanned (compose then fails closed on it as an unfilled placeholder).
 * Unknown placeholders are left in place for the lint step to reject.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] as string) : whole,
  );
}

// ---------------------------------------------------------------------------
// Skill body injection (template §1)
// ---------------------------------------------------------------------------

/**
 * Replace the INCLUDE SKILL.md section in the rendered prompt with the skill body.
 * The template has:
 *   ## 1. Operating rules
 *   INCLUDE: the body of `SKILL.md` from "Start→Style" ...
 */
function injectLine(rendered: string, marker: string, replacement: string): string {
  if (!replacement) return rendered;
  const idx = rendered.indexOf(marker);
  if (idx === -1) return rendered;
  // Find the full line containing the marker
  const lineStart = rendered.lastIndexOf("\n", idx) + 1;
  const lineEnd = rendered.indexOf("\n", idx);
  const end = lineEnd === -1 ? rendered.length : lineEnd + 1;
  return rendered.slice(0, lineStart) + replacement + "\n" + rendered.slice(end);
}

function injectSkillBody(rendered: string, skillBody: string): string {
  // The line to replace is the INCLUDE directive under ## 1. Operating rules
  return injectLine(rendered, "INCLUDE: the body of `SKILL.md`", stripPlaybooksSection(skillBody));
}

// ---------------------------------------------------------------------------
// Playbook filtering (§9) — playbooks_included already contains only used ones
// ---------------------------------------------------------------------------
// The caller sets input.playbooks_included to only the references the plan uses.
// The template's §9 just interpolates {{playbooks_included}}. No extra filtering
// needed here, but we normalize whitespace deterministically.

// ---------------------------------------------------------------------------
// Word budget + appendix overflow
// ---------------------------------------------------------------------------

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * If text exceeds wordBudget, split off overflow into appendix files.
 * Strategy: keep the main prompt under budget by moving the longest
 * table/list blocks (heuristic: split on large sections) into appendix.
 * Simple approach: if over budget, truncate appendix-eligible sections.
 */
function applyWordBudget(
  text: string,
  wordBudget: number,
): { prompt: string; appendix: Record<string, string> } {
  if (countWords(text) <= wordBudget) {
    return { prompt: text, appendix: {} };
  }

  // Identify large sections that are candidates for appendix extraction.
  // We look for sections that contain long tables/lists and move them.
  // For determinism: rank sections by descending word count, move largest first.
  const appendix: Record<string, string> = {};
  let prompt = text;
  let appendixIndex = 1;

  // Work iteratively: find the largest section > 200 words, extract it
  // We extract by replacing the section body with a reference line.
  while (countWords(prompt) > wordBudget) {
    const sections = splitSections(prompt);
    if (sections.length <= 1) break; // can't split further

    // Find largest extractable section (not "Start here" or "Operating rules")
    let bestIdx = -1;
    let bestWords = 0;
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i]!;
      // Don't extract critical sections
      if (/^## (Start here|1\. Operating rules)/.test(s.header)) continue;
      const wc = countWords(s.body);
      if (wc > bestWords) {
        bestWords = wc;
        bestIdx = i;
      }
    }
    if (bestIdx === -1 || bestWords < 50) break;

    const extracted = sections[bestIdx]!;
    const fileName = `appendix-${String(appendixIndex).padStart(2, "0")}.md`;
    appendix[fileName] = extracted.header + "\n" + extracted.body;
    sections[bestIdx] = { header: extracted.header, body: `> See \`${fileName}\` for full content.\n` };
    prompt = joinSections(sections);
    appendixIndex++;

    // Safety: avoid infinite loop
    if (appendixIndex > 20) break;
  }

  return { prompt, appendix };
}

interface Section {
  header: string;
  body: string;
}

function isTemplateSection(line: string): boolean {
  // Only prompt.template.md's own sections split for the word budget. Headings
  // inside included bodies (SKILL.md, ops-loop.md) must stay with their section.
  return /^## (?:Start here|\d+\.\s)/.test(line);
}

function splitSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    if (isTemplateSection(line) && current !== null) {
      sections.push(current);
      current = { header: line, body: "" };
    } else if (isTemplateSection(line) && current === null) {
      current = { header: line, body: "" };
    } else {
      if (current === null) {
        // Preamble before first heading
        current = { header: "", body: line + "\n" };
      } else {
        current.body += line + "\n";
      }
    }
  }
  if (current !== null) sections.push(current);
  return sections;
}

function joinSections(sections: Section[]): string {
  return sections
    .map((s) => (s.header ? s.header + "\n" + s.body : s.body))
    .join("");
}

// ---------------------------------------------------------------------------
// Public compose() — deterministic
// ---------------------------------------------------------------------------

export interface LintResult {
  ok: boolean;
  placeholders: string[];
  secrets: Array<{ pattern: string; match: string }>;
}

/**
 * Lint the composed text: check for unfilled placeholders and secrets.
 */
export function lint(text: string): LintResult {
  const placeholders = findPlaceholders(text);
  const secrets = scanSecrets(text);
  return { ok: placeholders.length === 0 && secrets.length === 0, placeholders, secrets };
}

/**
 * Render prompt.template.md with the given ComposeInput.
 *
 * - SKILL.md body (Start→Style) into §1 (Operating rules)
 * - Only plan-used references into §9 (via playbooks_included)
 * - Word budget enforcement (overflow → appendix files)
 * - Deterministic: same input → byte-identical output
 * - Fails closed on secrets / unfilled placeholders via lint()
 */
/**
 * Fail closed (SPEC §5, S10): refuse to emit prompt.md with unfilled
 * placeholders or anything secret-like, in the prompt or any appendix.
 * Error text names placeholders and secret pattern names only — never the
 * matched secret text itself.
 */
function assertLintClean(text: string, where: string): void {
  const result = lint(text);
  if (result.ok) return;
  const parts: string[] = [];
  if (result.placeholders.length > 0) {
    const unique = [...new Set(result.placeholders)].sort();
    parts.push(`unfilled placeholder(s): ${unique.join(", ")}`);
  }
  if (result.secrets.length > 0) {
    const patterns = [...new Set(result.secrets.map((f) => f.pattern))].sort();
    parts.push(`secret scan failed (pattern: ${patterns.join(", ")})`);
  }
  throw new Error(`compose failed: ${parts.join("; ")} in ${where}; refusing to emit prompt.md`);
}

export function compose(input: ComposeInput, opts: ComposeOptions = {}): ComposeResult {
  const valid = parseComposeInput(input);
  const template = loadTemplate(opts.template);
  const skillBody = loadSkillBody(opts.skillBody);
  const vars = flattenInput(valid);

  // 1. Render placeholders deterministically (single pass)
  // Strip HTML comment header (contains example {{placeholder}} that is not a real field)
  let rendered = template.replace(/<!--[\s\S]*?-->\s*\n?/, "");
  rendered = renderTemplate(rendered, vars);

  // 2. Inject included pack sections: SKILL.md body into §1, ops-loop into §6/§10
  rendered = injectSkillBody(rendered, skillBody);
  rendered = injectLine(rendered, "INCLUDE: `references/ops-loop.md` section 1.", loadOpsLoopSection(1, opts.hqSection));
  rendered = injectLine(rendered, "INCLUDE: `references/ops-loop.md` section 7.", loadOpsLoopSection(7, opts.weeklyReportSection));

  // 3. Normalize line endings (deterministic) and ensure single trailing newline
  rendered = rendered.replace(/\r\n/g, "\n");
  // Collapse 3+ consecutive newlines to 2 (paragraph break)
  rendered = rendered.replace(/\n{3,}/g, "\n\n");
  if (!rendered.endsWith("\n")) rendered += "\n";

  // 4. Fail closed before budget splitting, so secrets in overflow are caught too
  assertLintClean(rendered, "composed prompt");

  // 5. Apply word budget
  const budget = opts.wordBudget ?? WORD_BUDGET_DEFAULT;
  const { prompt, appendix } = applyWordBudget(rendered, budget);
  for (const [name, content] of Object.entries(appendix)) {
    assertLintClean(content, name);
  }

  return { prompt, appendix };
}
