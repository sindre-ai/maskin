import { randomUUID } from 'node:crypto'
import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { events, actors, agentSkills, workspaceMembers, workspaceSkills } from '@maskin/db/schema'
import { PLATFORM_MCP_PRESET, serializeSkillMd, skillNameSchema } from '@maskin/shared'
import { z } from 'zod'
import { logger } from '../lib/logger'
import type { AgentStorageManager } from './agent-storage'
import { type LlmCallInput, callLlm } from './llm-call'

// Server-side pipeline that turns a one-liner into an opinionated SME agent
// spec, registers a named actor, and attaches a SKILL.md with progressive
// disclosure. Six stages total; underspecified prompts short-circuit at
// stage 1 with a gap question — no actor is created.
//
// Stage sequencing:
//   Stage 1 → Stage 2                  — sequential (stage 2 consumes parsed
//                                        intent; stage 1 gates the underspec
//                                        early return).
//   Stage 3 || Stage 4                 — parallel via Promise.all. Both take
//                                        {intent, persona}; neither consumes
//                                        the other's output. Parallelizing
//                                        keeps the p95 budget in reach.
//   Actor + workspace_skill + attach   — sequential DB writes wrapped in a
//                                        single transaction so a mid-flight
//                                        failure leaves nothing behind.
//   S3 SKILL.md write                  — inside the same transaction. On S3
//                                        failure the tx rolls back — no
//                                        orphan rows. On tx-commit failure
//                                        (rare) the S3 object is orphaned but
//                                        keyed by UUID and unreachable.
//
// Prompt templates live inline as exported consts to match every other prompt
// in the codebase (BET_STRATEGIST_SYSTEM_PROMPT, workspace-briefing, session-
// manager default). Diffable, PR-reviewable, no extra abstraction until a
// stage grows past ~200 lines.

const STAGE_1_TEMPERATURE = 0.2
const STAGE_2_TEMPERATURE = 0.3
const STAGE_3_TEMPERATURE = 0.3
const STAGE_4_TEMPERATURE = 0.2
const STAGE_6_TEMPERATURE = 0.3
const STAGE_TIMEOUT_MS = 15_000

export const STAGE_1_PROMPT = `You extract structured intent from a one-line request for a new subject-matter-expert (SME) agent. Return STRICT JSON matching this shape (no prose, no code fences):

{
  "domain": string,                 // the field of expertise the agent works in
  "job_to_be_done": string,         // the outcome the caller wants the agent to produce
  "deliverables": string[],         // concrete artifacts the agent should return (may be empty)
  "constraints": string[],          // known constraints from the input (may be empty)
  "is_underspecified": boolean,     // true if EITHER domain OR job_to_be_done cannot be identified with confidence
  "missing": string[],              // when is_underspecified=true, the mandatory fields missing (e.g. ["domain","job_to_be_done"])
  "gap_question": string            // when is_underspecified=true, ONE direct question that would unblock you (empty string otherwise)
}

Rules:
- Never invent a domain or job the input does not support. When in doubt, mark is_underspecified=true.
- "constraints" and "deliverables" may be empty; only "domain" and "job_to_be_done" are mandatory for a well-specified input.
- Do not include markdown, backticks, or commentary — JSON only.`

export const STAGE_2_PROMPT = `You synthesize an opinionated SME persona from parsed intent. The persona is used to seed an agent that will end its answers with a clear recommendation and stated assumptions — never hedging. Return STRICT JSON matching this shape (no prose, no code fences):

{
  "name": string,                       // memorable persona name, ~1-3 words
  "role": string,                       // one-line role headline (e.g. "Senior migration architect")
  "backstory": string,                  // 3-6 sentences. MUST encode: (a) specific expertise, (b) a decision framework the agent uses, (c) at least two named biases/blind spots the agent is aware of.
  "scope_boundaries": string[],         // what this agent will and will NOT engage with
  "delegation_description": string,     // "Use this agent when..." — one sentence a caller can pattern-match on
  "tool_set": string[]                  // inferred minimal MCP/native tools the agent needs (short names, no prose)
}

Rules:
- Bias for opinion. A vague or diplomatic backstory is a failure of this stage.
- Never hedge in the persona ("might", "could be", "depending on") — this is a stance-bearing role, not a survey.
- Do not include markdown, backticks, or commentary — JSON only.`

export const STAGE_3_PROMPT = `You author the sectioned system prompt for a named SME agent, given its parsed intent and synthesized persona. The system prompt is what the agent will run on in every future session. It MUST cover every section below. Return STRICT JSON matching this shape (no prose, no code fences):

{
  "background": string,                 // 2-4 sentences: who this agent is, the domain, what makes them credible.
  "instructions": string[],             // 4-8 imperative bullet points the agent follows on every task. Concrete, not "be helpful".
  "decision_framework": string,         // The named framework or ordered heuristic the agent applies to trade-offs. Reference the persona's backstory.
  "tool_guidance": string,              // When the agent should reach for its tool_set vs. answer from own knowledge. Name the tools from persona.tool_set.
  "output_format": string,              // How the agent structures its response — sections, headings, length norms.
  "bias_statement": string,             // Explicit re-statement of the persona's named biases/blind spots so the agent flags them when relevant.
  "worked_examples": [                  // 2-5 examples. Each is a realistic in-domain ask + how this exact persona would respond.
    { "title": string, "ask": string, "response": string }
  ]
}

Rules:
- Fill EVERY field. Empty strings or empty arrays for any of background/instructions/decision_framework/tool_guidance/output_format/bias_statement are a failure of this stage.
- "worked_examples" must contain at least 2 and at most 5 items; each response must itself end with a clear recommendation and named assumptions — this is the pattern the agent will imitate.
- Ground every section in the persona's specific expertise and biases. Generic advice is a failure.
- Do not include markdown, backticks, or commentary — JSON only.`

export const STAGE_6_PROMPT = `You are a domain-critical reviewer. A single-prompt agent builder just produced an SME agent from a one-liner. Read the persona and the sectioned system prompt, then produce a concrete GAP REPORT — the specific missing context items a caller would need to hand the agent so it stops guessing.

Return STRICT JSON matching this shape (no prose, no code fences):

{
  "gap_items": [
    {
      "topic": string,          // 2-5 word label naming the missing input (e.g. "target database size", "SOC 2 constraints", "team size and seniority")
      "detail": string,          // 1-2 sentences describing exactly what the caller should provide, in the caller's language
      "why_it_matters": string   // 1 sentence tying it to a specific decision the agent has to make — reference the persona's decision framework or a section of the system prompt
    }
  ]
}

Rules:
- Return between 3 and 6 gap_items. Every item MUST be specific to THIS agent's domain, persona, and stated decision framework. Generic advice like "add more examples" or "describe your use case better" is a failure of this stage.
- Ground every item in something concrete from the persona backstory, the system prompt's decision framework, or the intent's stated constraints. If the persona names a bias (e.g. "under-values logical replication"), a gap item may target the context that would neutralise that bias.
- Do NOT re-ask for the domain or job-to-be-done — those are already established. Focus on the next layer of context (data shape, constraints, environment, stakeholders, precedent decisions, tooling in place).
- Do not include markdown, backticks, or commentary — JSON only.`

export const STAGE_4_PROMPT = `You produce the anti-hedging opinionation layer that will be spliced into an SME agent's system prompt. This is scaffolding that forces the agent to end every in-domain response with a clear recommendation and stated assumptions — never hedging. Return STRICT JSON matching this shape (no prose, no code fences):

{
  "opinionation_clause": string,             // A directive paragraph (3-6 sentences) written IN THE SECOND PERSON to the agent. It MUST: (a) forbid hedging language ("might", "could", "it depends") in the closing recommendation, (b) require every in-domain response to end with a "Recommendation:" line followed by an "Assumptions:" line, (c) instruct the agent to state assumptions explicitly rather than caveat.
  "recommendation_openings": string[],       // 3-5 concrete opening phrases the agent can pattern-match on for its Recommendation line (e.g. "Ship X", "Do Y first", "Reject the migration and instead ..."). Tailored to the persona's domain.
  "assumption_openings": string[]            // 2-4 opening phrases for the Assumptions line, tailored to the domain (e.g. "Assuming the table is under 1GB", "If you have OAuth already configured").
}

Rules:
- opinionation_clause MUST literally contain the words "Recommendation:" and "Assumptions:" so the agent can grep-match its own output shape.
- opinionation_clause MUST forbid hedging in the closing block.
- Openings should be domain-specific — generic openings ("Consider …", "It depends …") are a failure.
- Do not include markdown, backticks, or commentary — JSON only.`

const stage1Schema = z.object({
	domain: z.string().default(''),
	job_to_be_done: z.string().default(''),
	deliverables: z.array(z.string()).default([]),
	constraints: z.array(z.string()).default([]),
	is_underspecified: z.boolean(),
	missing: z.array(z.string()).default([]),
	gap_question: z.string().default(''),
})

const stage2Schema = z.object({
	name: z.string().min(1),
	role: z.string().min(1),
	backstory: z.string().min(1),
	scope_boundaries: z.array(z.string()).default([]),
	delegation_description: z.string().min(1),
	tool_set: z.array(z.string()).default([]),
})

const workedExampleSchema = z.object({
	title: z.string().min(1),
	ask: z.string().min(1),
	response: z.string().min(1),
})

const stage3Schema = z.object({
	background: z.string().min(1),
	instructions: z.array(z.string().min(1)).min(1),
	decision_framework: z.string().min(1),
	tool_guidance: z.string().min(1),
	output_format: z.string().min(1),
	bias_statement: z.string().min(1),
	worked_examples: z.array(workedExampleSchema).min(2).max(5),
})

const stage4Schema = z.object({
	opinionation_clause: z.string().min(1),
	recommendation_openings: z.array(z.string().min(1)).min(1),
	assumption_openings: z.array(z.string().min(1)).min(1),
})

const gapItemSchema = z.object({
	topic: z.string().min(1),
	detail: z.string().min(1),
	why_it_matters: z.string().min(1),
})

const stage6Schema = z.object({
	gap_items: z.array(gapItemSchema).min(1).max(8),
})

export type Stage1Output = z.infer<typeof stage1Schema>
export type PersonaSpec = z.infer<typeof stage2Schema>
export type SystemPromptSpec = z.infer<typeof stage3Schema>
export type OpinionationSpec = z.infer<typeof stage4Schema>
export type WorkedExample = z.infer<typeof workedExampleSchema>
export type GapItem = z.infer<typeof gapItemSchema>
export type GapReportSpec = z.infer<typeof stage6Schema>

export interface RunAgentBuilderInput {
	prompt: string
	examples?: string[]
	references?: string[]
	constraints?: string[]
}

/**
 * Handles required to complete the full pipeline (register actor + attach
 * SKILL.md). When absent, the pipeline stops after stage 4 and returns the
 * assembled artefacts without touching the DB — used by unit tests that
 * exercise the LLM-driven stages without a real workspace context.
 */
export interface AgentBuilderContext {
	db: Database
	agentStorage: AgentStorageManager
	workspaceId: string
	actorId: string
}

export type RunAgentBuilderResult =
	| { kind: 'gap_question'; gap_question: string; missing: string[] }
	| {
			kind: 'created'
			intent: Stage1Output
			persona: PersonaSpec
			systemPrompt: SystemPromptSpec
			opinionation: OpinionationSpec
			assembledSystemPrompt: string
			skillMd: string
			skillName: string
			actor: { id: string; name: string; description: string }
			skill: { id: string; name: string }
			gapReport: GapReportSpec
			gapReportMarkdown: string
			definitionSummary: string
			gapReportCommentPosted: boolean
	  }

export class AgentBuilderError extends Error {
	constructor(
		readonly reason:
			| 'llm_no_api_key'
			| 'llm_http_error'
			| 'llm_exception'
			| 'stage1_parse_error'
			| 'stage2_parse_error'
			| 'stage3_parse_error'
			| 'stage4_parse_error'
			| 'stage6_parse_error'
			| 'actor_registration_failed'
			| 'skill_registration_failed'
			| 'context_required',
		message: string,
	) {
		super(message)
		this.name = 'AgentBuilderError'
	}
}

function buildStage1UserMessage(input: RunAgentBuilderInput): string {
	const lines = [`ONE-LINER: ${input.prompt}`]
	if (input.examples?.length) lines.push(`EXAMPLES:\n- ${input.examples.join('\n- ')}`)
	if (input.references?.length) lines.push(`REFERENCES:\n- ${input.references.join('\n- ')}`)
	if (input.constraints?.length) lines.push(`CONSTRAINTS:\n- ${input.constraints.join('\n- ')}`)
	return lines.join('\n\n')
}

function buildStage2UserMessage(intent: Stage1Output): string {
	return [
		`DOMAIN: ${intent.domain}`,
		`JOB TO BE DONE: ${intent.job_to_be_done}`,
		intent.deliverables.length ? `DELIVERABLES:\n- ${intent.deliverables.join('\n- ')}` : '',
		intent.constraints.length ? `CONSTRAINTS:\n- ${intent.constraints.join('\n- ')}` : '',
	]
		.filter(Boolean)
		.join('\n\n')
}

function buildStage6UserMessage(
	intent: Stage1Output,
	persona: PersonaSpec,
	sections: SystemPromptSpec,
	assembledSystemPrompt: string,
): string {
	return [
		`DOMAIN: ${intent.domain}`,
		`JOB TO BE DONE: ${intent.job_to_be_done}`,
		intent.deliverables.length ? `DELIVERABLES:\n- ${intent.deliverables.join('\n- ')}` : '',
		intent.constraints.length ? `CONSTRAINTS:\n- ${intent.constraints.join('\n- ')}` : '',
		'',
		`PERSONA NAME: ${persona.name}`,
		`PERSONA ROLE: ${persona.role}`,
		`PERSONA BACKSTORY: ${persona.backstory}`,
		persona.scope_boundaries.length
			? `PERSONA SCOPE:\n- ${persona.scope_boundaries.join('\n- ')}`
			: '',
		`PERSONA DELEGATION: ${persona.delegation_description}`,
		'',
		`SYSTEM PROMPT DECISION FRAMEWORK: ${sections.decision_framework}`,
		`SYSTEM PROMPT BIAS STATEMENT: ${sections.bias_statement}`,
		'',
		'ASSEMBLED SYSTEM PROMPT (for reference — do NOT summarise it, look for missing input surfaces the agent depends on):',
		assembledSystemPrompt,
	]
		.filter(Boolean)
		.join('\n')
}

function buildPersonaContextMessage(intent: Stage1Output, persona: PersonaSpec): string {
	return [
		`DOMAIN: ${intent.domain}`,
		`JOB TO BE DONE: ${intent.job_to_be_done}`,
		`PERSONA NAME: ${persona.name}`,
		`PERSONA ROLE: ${persona.role}`,
		`PERSONA BACKSTORY: ${persona.backstory}`,
		persona.scope_boundaries.length ? `SCOPE:\n- ${persona.scope_boundaries.join('\n- ')}` : '',
		`DELEGATION DESCRIPTION: ${persona.delegation_description}`,
		persona.tool_set.length ? `TOOL SET:\n- ${persona.tool_set.join('\n- ')}` : '',
	]
		.filter(Boolean)
		.join('\n\n')
}

function safeParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw)
	} catch {
		const match = raw.match(/\{[\s\S]*\}/)
		if (!match) return null
		try {
			return JSON.parse(match[0])
		} catch {
			return null
		}
	}
}

async function runStage(
	stage: 'stage1' | 'stage2' | 'stage3' | 'stage4' | 'stage6',
	params: LlmCallInput,
): Promise<string> {
	const result = await callLlm(params)
	if (!result.ok) {
		if (result.reason === 'no_api_key') {
			throw new AgentBuilderError('llm_no_api_key', `${stage}: LLM key not configured`)
		}
		if (result.reason === 'http_error') {
			throw new AgentBuilderError(
				'llm_http_error',
				`${stage}: LLM returned HTTP ${result.status ?? 'unknown'}`,
			)
		}
		throw new AgentBuilderError('llm_exception', `${stage}: LLM request failed`)
	}
	return result.content
}

/**
 * Turn a persona name into a workspace-skill name. Skill names must be
 * lowercase, hyphens only, ≤64 chars. We suffix a short random tail so two
 * calls that pick the same name never collide on the workspace-unique index.
 */
export function personaSkillName(personaName: string): string {
	const base =
		personaName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48) || 'sme-agent'
	const tail = randomUUID().slice(0, 8)
	const combined = `${base}-${tail}`
	// skillNameSchema enforces the same shape; assert to catch drift early.
	skillNameSchema.parse(combined)
	return combined
}

/**
 * Assemble the final system prompt. Stage 3 authored the sections; stage 4
 * authored the opinionation clause. This composition is deterministic — the
 * rules for how sections combine belong in code, not an LLM call, so a
 * reviewer can diff the exact prompt an agent will run.
 */
export function assembleSystemPrompt(
	persona: PersonaSpec,
	sections: SystemPromptSpec,
	opinionation: OpinionationSpec,
): string {
	const instructionLines = sections.instructions.map((line) => `- ${line}`).join('\n')
	const recOpenings = opinionation.recommendation_openings.map((line) => `- ${line}`).join('\n')
	const assumeOpenings = opinionation.assumption_openings.map((line) => `- ${line}`).join('\n')

	return [
		`# ${persona.name} — ${persona.role}`,
		'',
		'## Background',
		sections.background,
		'',
		'## Instructions',
		instructionLines,
		'',
		'## Decision framework',
		sections.decision_framework,
		'',
		'## Tool guidance',
		sections.tool_guidance,
		'',
		'## Output format',
		sections.output_format,
		'',
		'## Named biases and blind spots',
		sections.bias_statement,
		'',
		'## Response protocol — MUST FOLLOW',
		opinionation.opinionation_clause,
		'',
		'Recommendation line openings you can use:',
		recOpenings,
		'',
		'Assumptions line openings you can use:',
		assumeOpenings,
	].join('\n')
}

/**
 * Append worked examples as a reference section. The comment above the
 * section is a deliberate progressive-disclosure marker: the agent should
 * only read below this line when a caller's ask matches one of the titled
 * scenarios, not on every activation.
 */
function renderWorkedExamplesSection(workedExamples: WorkedExample[]): string {
	const lines: string[] = [
		'',
		'---',
		'',
		'# Reference — Worked examples',
		'',
		"*Load this section only when a caller's ask matches one of the scenarios below. These are reference, not always-read.*",
		'',
	]
	for (const example of workedExamples) {
		lines.push(
			`## ${example.title}`,
			'',
			`**Ask:** ${example.ask}`,
			'',
			`**Response:** ${example.response}`,
			'',
		)
	}
	return lines.join('\n')
}

/**
 * Assemble the SKILL.md string. Progressive disclosure:
 *  - Frontmatter (always loaded): name + one-line description from persona.delegation_description.
 *  - Body (on activation): the sectioned system prompt.
 *  - Worked examples (on demand): appended below a horizontal rule with an
 *    explicit "load on demand" marker.
 */
export function assembleSkillMd(
	skillName: string,
	persona: PersonaSpec,
	sections: SystemPromptSpec,
	opinionation: OpinionationSpec,
): string {
	const systemPrompt = assembleSystemPrompt(persona, sections, opinionation)
	const workedExamples = renderWorkedExamplesSection(sections.worked_examples)
	return serializeSkillMd({
		name: skillName,
		description: persona.delegation_description,
		content: `${systemPrompt}\n${workedExamples}`,
	})
}

interface RegistrationInputs {
	ctx: AgentBuilderContext
	persona: PersonaSpec
	assembledSystemPrompt: string
	skillName: string
	skillMd: string
}

async function registerActorAndSkill(inputs: RegistrationInputs): Promise<{
	actor: { id: string; name: string; description: string }
	skill: { id: string; name: string }
}> {
	const { ctx, persona, assembledSystemPrompt, skillName, skillMd } = inputs
	const description = persona.delegation_description.slice(0, 80)
	const skillId = randomUUID()
	const sizeBytes = Buffer.byteLength(skillMd, 'utf-8')
	const storageKey = `workspaces/${ctx.workspaceId}/skills/${skillId}/SKILL.md`

	// Actor + workspace_members + workspace_skill + agent_skill inside a single
	// transaction. The S3 write happens inside too so a rejected object rolls
	// back the whole set.
	let created: {
		actor: { id: string; name: string; description: string }
		skill: { id: string; name: string }
	}
	let s3PutSucceeded = false
	try {
		created = await ctx.db.transaction(async (tx) => {
			const actorRows = await tx
				.insert(actors)
				.values({
					type: 'agent',
					name: persona.name,
					description,
					systemPrompt: assembledSystemPrompt,
					apiKey: generateApiKey().key,
					tools: {
						mcpServers: {
							maskin: PLATFORM_MCP_PRESET,
						},
					},
					createdBy: ctx.actorId,
				})
				.returning()
			const actor = actorRows[0]
			if (!actor) throw new Error('actor INSERT returned no row')

			await tx.insert(workspaceMembers).values({
				workspaceId: ctx.workspaceId,
				actorId: actor.id,
				role: 'member',
			})

			const skillRows = await tx
				.insert(workspaceSkills)
				.values({
					id: skillId,
					workspaceId: ctx.workspaceId,
					name: skillName,
					description: persona.delegation_description,
					content: skillMd,
					storageKey,
					sizeBytes,
					isValid: true,
					createdBy: ctx.actorId,
				})
				.returning()
			const skill = skillRows[0]
			if (!skill) throw new Error('workspace_skill INSERT returned no row')

			await tx.insert(agentSkills).values({
				actorId: actor.id,
				workspaceSkillId: skill.id,
			})

			await ctx.agentStorage.putWorkspaceSkill(ctx.workspaceId, skill.id, skillMd)
			s3PutSucceeded = true

			return {
				actor: { id: actor.id, name: actor.name, description: actor.description ?? '' },
				skill: { id: skill.id, name: skill.name },
			}
		})
	} catch (err) {
		if (s3PutSucceeded) {
			logger.error('agent-builder: tx-commit failure after S3 put — orphan object', {
				workspaceId: ctx.workspaceId,
				skillId,
				storageKey,
				error: String(err),
			})
		}
		logger.error('agent-builder: actor/skill registration failed', {
			workspaceId: ctx.workspaceId,
			error: String(err),
		})
		throw new AgentBuilderError(
			'actor_registration_failed',
			err instanceof Error ? err.message : 'DB write failed during actor/skill registration',
		)
	}

	// Audit events — fire-and-forget. A failure to record audit must NOT
	// translate into a 500 for the caller; the mutation has already committed.
	try {
		await ctx.db.insert(events).values({
			workspaceId: ctx.workspaceId,
			actorId: ctx.actorId,
			action: 'created',
			entityType: 'actor',
			entityId: created.actor.id,
			data: {
				id: created.actor.id,
				name: created.actor.name,
				description: created.actor.description,
				source: 'agent_builder',
			},
		})
		await ctx.db.insert(events).values({
			workspaceId: ctx.workspaceId,
			actorId: ctx.actorId,
			action: 'created',
			entityType: 'workspace_skill',
			entityId: created.skill.id,
			data: {
				id: created.skill.id,
				name: created.skill.name,
				description: persona.delegation_description,
				sizeBytes,
				source: 'agent_builder',
			},
		})
	} catch (err) {
		logger.error('agent-builder: failed to record audit events', {
			workspaceId: ctx.workspaceId,
			actorId: created.actor.id,
			skillId: created.skill.id,
			error: String(err),
		})
	}

	return created
}

export async function runAgentBuilder(
	input: RunAgentBuilderInput,
	ctx: AgentBuilderContext,
): Promise<RunAgentBuilderResult> {
	// ── Stage 1: intent extraction + underspecification gate ────────────────
	// Must run first; stage 2 depends on its output AND we short-circuit here
	// when the prompt is underspecified (per bet DoD: no hallucinated fills).
	const stage1Raw = await runStage('stage1', {
		system: STAGE_1_PROMPT,
		user: buildStage1UserMessage(input),
		temperature: STAGE_1_TEMPERATURE,
		maxTokens: 600,
		timeoutMs: STAGE_TIMEOUT_MS,
		jsonMode: true,
	})

	const stage1Parsed = stage1Schema.safeParse(safeParseJson(stage1Raw))
	if (!stage1Parsed.success) {
		logger.error('agent-builder: stage1 parse failed', {
			issues: stage1Parsed.error.issues,
			rawPreview: stage1Raw.slice(0, 200),
		})
		throw new AgentBuilderError('stage1_parse_error', 'stage1: LLM returned invalid JSON shape')
	}
	const intent = stage1Parsed.data

	const underspecified =
		intent.is_underspecified || !intent.domain.trim() || !intent.job_to_be_done.trim()
	if (underspecified) {
		const gapQuestion =
			intent.gap_question.trim() ||
			'Can you tell me the domain and the specific outcome you want this agent to deliver?'
		const missing =
			intent.missing.length > 0
				? intent.missing
				: [
						!intent.domain.trim() ? 'domain' : null,
						!intent.job_to_be_done.trim() ? 'job_to_be_done' : null,
					].filter((v): v is string => Boolean(v))
		return { kind: 'gap_question', gap_question: gapQuestion, missing }
	}

	// ── Stage 2: persona synthesis ──────────────────────────────────────────
	// Sequential after stage 1 — takes parsed intent as input.
	const stage2Raw = await runStage('stage2', {
		system: STAGE_2_PROMPT,
		user: buildStage2UserMessage(intent),
		temperature: STAGE_2_TEMPERATURE,
		maxTokens: 900,
		timeoutMs: STAGE_TIMEOUT_MS,
		jsonMode: true,
	})

	const stage2Parsed = stage2Schema.safeParse(safeParseJson(stage2Raw))
	if (!stage2Parsed.success) {
		logger.error('agent-builder: stage2 parse failed', {
			issues: stage2Parsed.error.issues,
			rawPreview: stage2Raw.slice(0, 200),
		})
		throw new AgentBuilderError('stage2_parse_error', 'stage2: LLM returned invalid JSON shape')
	}
	const persona = stage2Parsed.data

	// ── Stages 3 & 4: system prompt authoring + opinionation layer ─────────
	// Both take {intent, persona} and produce independent artefacts, so they
	// run in parallel to protect the p95 <30s budget.
	const personaContext = buildPersonaContextMessage(intent, persona)
	const [stage3Raw, stage4Raw] = await Promise.all([
		runStage('stage3', {
			system: STAGE_3_PROMPT,
			user: personaContext,
			temperature: STAGE_3_TEMPERATURE,
			maxTokens: 1800,
			timeoutMs: STAGE_TIMEOUT_MS,
			jsonMode: true,
		}),
		runStage('stage4', {
			system: STAGE_4_PROMPT,
			user: personaContext,
			temperature: STAGE_4_TEMPERATURE,
			maxTokens: 700,
			timeoutMs: STAGE_TIMEOUT_MS,
			jsonMode: true,
		}),
	])

	const stage3Parsed = stage3Schema.safeParse(safeParseJson(stage3Raw))
	if (!stage3Parsed.success) {
		logger.error('agent-builder: stage3 parse failed', {
			issues: stage3Parsed.error.issues,
			rawPreview: stage3Raw.slice(0, 200),
		})
		throw new AgentBuilderError(
			'stage3_parse_error',
			'stage3: LLM returned invalid system-prompt shape (missing required sections or too few worked examples)',
		)
	}

	const stage4Parsed = stage4Schema.safeParse(safeParseJson(stage4Raw))
	if (!stage4Parsed.success) {
		logger.error('agent-builder: stage4 parse failed', {
			issues: stage4Parsed.error.issues,
			rawPreview: stage4Raw.slice(0, 200),
		})
		throw new AgentBuilderError(
			'stage4_parse_error',
			'stage4: LLM returned invalid opinionation shape',
		)
	}

	const sections = stage3Parsed.data
	const opinionation = stage4Parsed.data
	const assembledSystemPrompt = assembleSystemPrompt(persona, sections, opinionation)
	const skillName = personaSkillName(persona.name)
	const skillMd = assembleSkillMd(skillName, persona, sections, opinionation)

	// ── Stage 5: actor + skill registration + attach ───────────────────────
	const { actor, skill } = await registerActorAndSkill({
		ctx,
		persona,
		assembledSystemPrompt,
		skillName,
		skillMd,
	})

	// ── Stage 6: gap report ────────────────────────────────────────────────
	// One LLM call surveys the assembled persona and system prompt, then names
	// the concrete missing context items a caller would need to give the agent
	// so it stops guessing. Posted as a comment on the newly created actor.
	// Comment-write failures degrade gracefully — the report still ships back
	// in the tool response so the caller can act on it.
	const stage6Raw = await runStage('stage6', {
		system: STAGE_6_PROMPT,
		user: buildStage6UserMessage(intent, persona, sections, assembledSystemPrompt),
		temperature: STAGE_6_TEMPERATURE,
		maxTokens: 900,
		timeoutMs: STAGE_TIMEOUT_MS,
		jsonMode: true,
	})

	const stage6Parsed = stage6Schema.safeParse(safeParseJson(stage6Raw))
	if (!stage6Parsed.success) {
		logger.error('agent-builder: stage6 parse failed', {
			issues: stage6Parsed.error.issues,
			rawPreview: stage6Raw.slice(0, 200),
		})
		throw new AgentBuilderError(
			'stage6_parse_error',
			'stage6: LLM returned invalid gap-report shape',
		)
	}
	const gapReport = stage6Parsed.data
	const gapReportMarkdown = formatGapReportMarkdown(persona, gapReport)
	const definitionSummary = composeDefinitionSummary(persona)
	const gapReportCommentPosted = await postGapReportComment(ctx, actor.id, gapReportMarkdown)

	return {
		kind: 'created',
		intent,
		persona,
		systemPrompt: sections,
		opinionation,
		assembledSystemPrompt,
		skillMd,
		skillName,
		actor,
		skill,
		gapReport,
		gapReportMarkdown,
		definitionSummary,
		gapReportCommentPosted,
	}
}

/**
 * Compose the caller-facing summary of what was created. Deterministic —
 * doesn't cost an extra LLM call. One paragraph: name + role + delegation.
 */
export function composeDefinitionSummary(persona: PersonaSpec): string {
	return `${persona.name} — ${persona.role}. ${persona.delegation_description}`
}

/**
 * Render the gap report as a markdown comment body. The structure mirrors
 * the JSON shape stage 6 returns so a caller can pattern-match, but it's
 * comment-friendly (headings, bullets) rather than raw JSON.
 */
export function formatGapReportMarkdown(persona: PersonaSpec, report: GapReportSpec): string {
	const lines: string[] = [
		`## Gap report for ${persona.name}`,
		'',
		"Context this agent doesn't yet have. Provide any of these to a session and its answers get sharper — leave them missing and it will hedge or guess.",
		'',
	]
	for (const item of report.gap_items) {
		lines.push(
			`### ${item.topic}`,
			'',
			item.detail,
			'',
			`_Why it matters:_ ${item.why_it_matters}`,
			'',
		)
	}
	return lines.join('\n').trimEnd()
}

/**
 * Insert a `commented` event on the newly created actor carrying the gap
 * report body. Any DB failure is logged and swallowed — the tool response
 * still carries the report so the caller can act on it. Returns whether the
 * comment was successfully persisted.
 */
async function postGapReportComment(
	ctx: AgentBuilderContext,
	actorEntityId: string,
	body: string,
): Promise<boolean> {
	try {
		await ctx.db.insert(events).values({
			workspaceId: ctx.workspaceId,
			actorId: ctx.actorId,
			action: 'commented',
			entityType: 'actor',
			entityId: actorEntityId,
			data: {
				content: body,
				source: 'agent_builder_gap_report',
			},
		})
		return true
	} catch (err) {
		logger.error('agent-builder: gap-report comment insert failed', {
			workspaceId: ctx.workspaceId,
			actorEntityId,
			error: String(err),
		})
		return false
	}
}
