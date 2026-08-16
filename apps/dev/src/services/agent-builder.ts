import type { Database } from '@maskin/db'
import {
	events,
	actors,
	agentSkills,
	objects,
	sessions,
	workspaceMembers,
	workspaceSkills,
} from '@maskin/db/schema'
import { serializeSkillMd } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { logger } from '../lib/logger'
import {
	type ReviewerVerdict,
	failingCriteriaNames,
	getOrBootstrapCanonicalRubric,
	resolveRubricById,
	runAgentReviewer,
	trackReviewerVerdictSubmitted,
} from './agent-reviewer'
import type { AgentStorageManager } from './agent-storage'
import { type LlmCallInput, callLlm } from './llm-call'
import {
	type PrecisionSummary,
	ReviewerVerdictError,
	computeReviewerPrecision,
	rateReviewerVerdict,
	recordReviewerVerdict,
} from './reviewer-verdicts'

// Shared system-prompt authoring (stages 3-4) plus the two standalone tools
// that reuse it: maskin_reviewer_verdict (fresh-context rubric scoring
// against an arbitrary object/session, plus rating + precision summary) and
// maskin_refine_agent (re-author an existing actor's system prompt from a
// free-text instruction).
//
// The maskin_create_agent CREATE path no longer lives here — it moved to a
// single async container agent session (see agent-builder-bootstrap.ts for
// the session's system prompt + bootstrap, and routes/agent-builder.ts's
// /create handler for how the session gets kicked off). That session does
// intent extraction, persona synthesis, system-prompt authoring, opinionation,
// self-critique, and actor/skill registration itself via its own tool calls —
// none of that is server-side orchestrated raw-LLM-call code anymore.

const STAGE_3_TEMPERATURE = 0.3
const STAGE_4_TEMPERATURE = 0.2
// 15s was measured to be too tight for the configured MASKIN_FALLBACK model
// (deepseek/deepseek-v4-flash via OpenRouter): a direct timed call with a
// stage-2-sized prompt (~900 max_tokens, json_mode) took 27.4s end to end.
// That's provider/model latency, not a function of any one stage's token
// budget, so every stage needs headroom — not just the largest one.
const STAGE_TIMEOUT_MS = 60_000
// Stage 3 authors the full system prompt (background, instructions, up to 5
// worked examples) at maxTokens: 4500. Measured directly against the fallback
// model: a 3-worked-example response used 1877 completion tokens at ~31
// tok/s; a full 5-example response can run close to the cap, which at this
// throughput needs ~130s+. Generous on purpose — better a slow success than
// a truncated-JSON failure.
const STAGE_3_TIMEOUT_MS = 150_000

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
- Do not include markdown, backticks, or commentary — JSON only.
- If the user message includes a CURRENT SYSTEM PROMPT block, this is a REVISION, not a fresh authoring: for every field, reproduce the current wording as closely as possible and change ONLY what the REVISION FEEDBACK requires. A field the feedback doesn't mention must come back unchanged in meaning and wording. Rewriting, reorganizing, or "improving" a section the feedback never named is a failure of this stage.`

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
- Do not include markdown, backticks, or commentary — JSON only.
- If the user message includes a CURRENT SYSTEM PROMPT block, this is a REVISION, not a fresh authoring: reproduce the current opinionation_clause / recommendation_openings / assumption_openings as closely as possible and change ONLY what the REVISION FEEDBACK requires. Do not rewrite fields the feedback never named.`

// Plain type aliases (not zod-derived) — the LLM calls that used to produce
// these shapes (stage 1 intent extraction, stage 2 persona synthesis) no
// longer exist server-side; the async create-agent session does that
// reasoning itself. These types survive only because refineAgent() still
// synthesizes values of these shapes from an existing actor row to feed
// runStages3And4().
export interface Stage1Output {
	domain: string
	job_to_be_done: string
	deliverables: string[]
	constraints: string[]
	is_underspecified: boolean
	missing: string[]
	gap_question: string
}

export interface PersonaSpec {
	name: string
	role: string
	backstory: string
	scope_boundaries: string[]
	delegation_description: string
	tool_set: string[]
}

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

export type SystemPromptSpec = z.infer<typeof stage3Schema>
export type OpinionationSpec = z.infer<typeof stage4Schema>
export type WorkedExample = z.infer<typeof workedExampleSchema>

/**
 * Handles required by refineAgent() to update an actor + republish its
 * SKILL.md.
 */
export interface AgentBuilderContext {
	db: Database
	agentStorage: AgentStorageManager
	workspaceId: string
	actorId: string
}

export class AgentBuilderError extends Error {
	constructor(
		readonly reason:
			| 'llm_no_api_key'
			| 'llm_http_error'
			| 'llm_exception'
			| 'stage3_parse_error'
			| 'stage4_parse_error'
			| 'actor_registration_failed',
		message: string,
	) {
		super(message)
		this.name = 'AgentBuilderError'
	}
}

function buildPersonaContextMessage(
	intent: Stage1Output,
	persona: PersonaSpec,
	revisionNotes?: string[],
	currentSystemPrompt?: string,
): string {
	const revisionBlock =
		revisionNotes && revisionNotes.length > 0
			? `REVISION FEEDBACK (address every item — a prior reviewer pass flagged these):\n- ${revisionNotes.join('\n- ')}`
			: ''
	// Anchors the model on the actual current wording so it can carry sections
	// forward verbatim instead of re-deriving the whole prompt from the thin
	// synthesized persona below — without this, unrelated sections drift on
	// every refine call. See refineAgent()'s doc comment.
	const currentPromptBlock = currentSystemPrompt
		? `CURRENT SYSTEM PROMPT (verbatim — this is what the agent runs on today):\n${currentSystemPrompt}\n\nThis is a REVISION. Carry every field's current wording forward unchanged unless the REVISION FEEDBACK above specifically requires a change to it.`
		: ''
	return [
		`DOMAIN: ${intent.domain}`,
		`JOB TO BE DONE: ${intent.job_to_be_done}`,
		`PERSONA NAME: ${persona.name}`,
		`PERSONA ROLE: ${persona.role}`,
		`PERSONA BACKSTORY: ${persona.backstory}`,
		persona.scope_boundaries.length ? `SCOPE:\n- ${persona.scope_boundaries.join('\n- ')}` : '',
		`DELEGATION DESCRIPTION: ${persona.delegation_description}`,
		persona.tool_set.length ? `TOOL SET:\n- ${persona.tool_set.join('\n- ')}` : '',
		revisionBlock,
		currentPromptBlock,
	]
		.filter(Boolean)
		.join('\n\n')
}

function stripCodeFences(raw: string): string {
	// LLMs frequently wrap JSON in ```json ... ``` fences despite instructions
	// otherwise. Strip a leading fence (with any language tag) and a trailing
	// fence — including the case where the trailing fence was truncated by a
	// max_tokens ceiling and never emitted.
	let trimmed = raw.trim()
	const openFence = trimmed.match(/^```[a-zA-Z0-9_-]*\r?\n/)
	if (openFence) trimmed = trimmed.slice(openFence[0].length)
	const closeFence = trimmed.match(/\r?\n?```\s*$/)
	if (closeFence) trimmed = trimmed.slice(0, trimmed.length - closeFence[0].length)
	return trimmed.trim()
}

export function safeParseJson(raw: string): unknown {
	const cleaned = stripCodeFences(raw)
	try {
		return JSON.parse(cleaned)
	} catch {
		const match = cleaned.match(/\{[\s\S]*\}/)
		if (!match) return null
		try {
			return JSON.parse(match[0])
		} catch {
			return null
		}
	}
}

async function runStage(stage: 'stage3' | 'stage4', params: LlmCallInput): Promise<string> {
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

/**
 * Run stages 3 (system prompt author) + 4 (opinionation layer) as one
 * parallel dispatch. Used only by refineAgent() now — the create path's
 * former reviewer revision loop that re-ran this pair moved into the async
 * session's own self-critique skill.
 */
async function runStages3And4(
	intent: Stage1Output,
	persona: PersonaSpec,
	revisionNotes?: string[],
	currentSystemPrompt?: string,
): Promise<{ sections: SystemPromptSpec; opinionation: OpinionationSpec }> {
	const personaContext = buildPersonaContextMessage(
		intent,
		persona,
		revisionNotes,
		currentSystemPrompt,
	)
	const stage3Params: LlmCallInput = {
		system: STAGE_3_PROMPT,
		user: personaContext,
		temperature: STAGE_3_TEMPERATURE,
		// 1800, then 3000, both measured too low: with up to 5 worked
		// examples the model can need close to 3000 tokens just for
		// examples, on top of the other 6 sections. 4500 gives real
		// headroom against a truncated, unparseable JSON tail.
		maxTokens: 4500,
		timeoutMs: STAGE_3_TIMEOUT_MS,
		jsonMode: true,
	}
	const stage4Params: LlmCallInput = {
		system: STAGE_4_PROMPT,
		user: personaContext,
		temperature: STAGE_4_TEMPERATURE,
		// 700 measured too low: this model does visible chain-of-thought
		// reasoning that shares the same completion-token budget as the
		// JSON answer, and how much it "thinks" before answering varies
		// per call — one run consumed the entire 700-token cap on
		// reasoning and returned empty content. 1500 gives headroom (a
		// content-only reproduction of this exact prompt used 291 tokens).
		maxTokens: 1500,
		timeoutMs: STAGE_TIMEOUT_MS,
		jsonMode: true,
	}
	const [stage3Raw, stage4Raw] = await Promise.all([
		runStage('stage3', stage3Params),
		runStage('stage4', stage4Params),
	])

	let stage3Parsed = stage3Schema.safeParse(safeParseJson(stage3Raw))
	// Measured directly against the fallback model: stage 3 can return
	// complete, valid JSON that simply undershoots the "2-5 worked examples"
	// instruction (e.g. 1 example). That's not truncation or a network
	// failure a bigger token budget or callLlm's own retry can catch — it's a
	// content-quality miss that needs a fresh generation. One retry,
	// stage 3 only (stage 4 already succeeded above and doesn't need
	// re-running).
	if (!stage3Parsed.success) {
		logger.warn('agent-builder: stage3 parse failed, retrying once', {
			issues: stage3Parsed.error.issues,
			rawPreview: stage3Raw.slice(0, 200),
		})
		const stage3RetryRaw = await runStage('stage3', stage3Params)
		stage3Parsed = stage3Schema.safeParse(safeParseJson(stage3RetryRaw))
		if (!stage3Parsed.success) {
			logger.error('agent-builder: stage3 parse failed after retry', {
				issues: stage3Parsed.error.issues,
				rawPreview: stage3RetryRaw.slice(0, 200),
			})
			throw new AgentBuilderError(
				'stage3_parse_error',
				'stage3: LLM returned invalid system-prompt shape (missing required sections or too few worked examples)',
			)
		}
	}

	let stage4Parsed = stage4Schema.safeParse(safeParseJson(stage4Raw))
	// Same rationale as stage 3's retry above: this model's variable
	// chain-of-thought reasoning can eat into the answer budget mid-response,
	// leaving a truncated, unparseable JSON tail even at a generous token cap.
	// One retry, stage 4 only (stage 3 already succeeded above).
	if (!stage4Parsed.success) {
		logger.warn('agent-builder: stage4 parse failed, retrying once', {
			issues: stage4Parsed.error.issues,
			rawPreview: stage4Raw.slice(0, 200),
		})
		const stage4RetryRaw = await runStage('stage4', stage4Params)
		stage4Parsed = stage4Schema.safeParse(safeParseJson(stage4RetryRaw))
		if (!stage4Parsed.success) {
			logger.error('agent-builder: stage4 parse failed after retry', {
				issues: stage4Parsed.error.issues,
				rawPreview: stage4RetryRaw.slice(0, 200),
			})
			throw new AgentBuilderError(
				'stage4_parse_error',
				'stage4: LLM returned invalid opinionation shape',
			)
		}
	}

	return { sections: stage3Parsed.data, opinionation: stage4Parsed.data }
}

// ── Standalone reviewer path (maskin_reviewer_verdict) ───────────────────────

export class AgentReviewTargetError extends Error {
	constructor(
		readonly reason:
			| 'target_not_found'
			| 'target_wrong_workspace'
			| 'object_no_content'
			| 'session_not_terminal'
			| 'session_no_result'
			| 'rubric_not_found'
			| 'no_target_specified'
			| 'no_verdict_to_rate',
		message: string,
	) {
		super(message)
		this.name = 'AgentReviewTargetError'
	}
}

const TERMINAL_SESSION_STATUSES = new Set(['completed', 'failed', 'timeout'])

/**
 * Resolve the review target's definition text from either an object or a
 * session id. Object path reads `objects.content`; session path reads
 * `sessions.result` (requires a terminal status — a still-running session
 * has nothing final to score).
 */
export async function loadReviewTarget(
	db: Database,
	workspaceId: string,
	target: { objectId?: string; sessionId?: string },
): Promise<{ definitionText: string; targetActorId: string | null }> {
	if (target.objectId) {
		const rows = await db
			.select({
				content: objects.content,
				workspaceId: objects.workspaceId,
			})
			.from(objects)
			.where(eq(objects.id, target.objectId))
			.limit(1)
		const row = rows[0]
		if (!row) {
			throw new AgentReviewTargetError('target_not_found', `Object ${target.objectId} not found`)
		}
		if (row.workspaceId !== workspaceId) {
			throw new AgentReviewTargetError(
				'target_wrong_workspace',
				`Object ${target.objectId} does not belong to workspace ${workspaceId}`,
			)
		}
		const definitionText = (row.content ?? '').trim()
		if (!definitionText) {
			throw new AgentReviewTargetError(
				'object_no_content',
				`Object ${target.objectId} has no content to review`,
			)
		}
		return { definitionText, targetActorId: null }
	}

	if (target.sessionId) {
		const rows = await db
			.select({
				status: sessions.status,
				result: sessions.result,
				workspaceId: sessions.workspaceId,
				actorId: sessions.actorId,
			})
			.from(sessions)
			.where(eq(sessions.id, target.sessionId))
			.limit(1)
		const row = rows[0]
		if (!row) {
			throw new AgentReviewTargetError('target_not_found', `Session ${target.sessionId} not found`)
		}
		if (row.workspaceId !== workspaceId) {
			throw new AgentReviewTargetError(
				'target_wrong_workspace',
				`Session ${target.sessionId} does not belong to workspace ${workspaceId}`,
			)
		}
		if (!TERMINAL_SESSION_STATUSES.has(row.status)) {
			throw new AgentReviewTargetError(
				'session_not_terminal',
				`Session ${target.sessionId} status is "${row.status}" — must be completed/failed/timeout to review`,
			)
		}
		const serialised = row.result ? JSON.stringify(row.result) : ''
		if (!serialised.trim()) {
			throw new AgentReviewTargetError(
				'session_no_result',
				`Session ${target.sessionId} has no result payload to review`,
			)
		}
		return { definitionText: serialised, targetActorId: row.actorId }
	}

	throw new AgentReviewTargetError(
		'target_not_found',
		'Provide exactly one of object_id or session_id',
	)
}

export async function reviewWork(
	db: Database,
	p: {
		workspaceId: string
		actorId: string
		objectId?: string
		sessionId?: string
		rubricId?: string
		// Only consulted on the object_id path — the session_id path always
		// derives its own target actor from the session row. Reviewing a
		// generic object has no inherent actor association, so the verdict
		// can't be persisted (reviewer_verdicts.target_actor_id is NOT NULL)
		// unless the caller names one explicitly.
		targetActorId?: string
	},
): Promise<{
	verdict: ReviewerVerdict
	reviewerSessionId: string
	rubricId: string
	targetActorId: string | null
	verdictId: string | null
	persisted: boolean
	persistenceNote?: string
}> {
	const { definitionText, targetActorId: sessionTargetActorId } = await loadReviewTarget(
		db,
		p.workspaceId,
		{ objectId: p.objectId, sessionId: p.sessionId },
	)
	const targetActorId = sessionTargetActorId ?? p.targetActorId ?? null

	const rubric = p.rubricId
		? await resolveRubricById(db, p.workspaceId, p.rubricId)
		: await getOrBootstrapCanonicalRubric(db, p.workspaceId, p.actorId)
	if (!rubric) {
		throw new AgentReviewTargetError(
			'rubric_not_found',
			`Rubric ${p.rubricId} not found in workspace ${p.workspaceId}`,
		)
	}

	const { verdict, reviewerSessionId } = await runAgentReviewer({
		definitionText,
		rubricBody: rubric.content,
	})

	await trackReviewerVerdictSubmitted(db, {
		workspaceId: p.workspaceId,
		actorId: p.actorId,
		targetActorId,
		rubricId: rubric.id,
		overall: verdict.overall,
		cycleNumber: 1,
		reviewerSessionId,
		failingCriteria: failingCriteriaNames(verdict),
	})

	// Persist so the verdict becomes ratable — rating and the precision
	// summary (both folded into maskin_reviewer_verdict alongside review)
	// read from reviewer_verdicts, not from this call's return value.
	// Best-effort: a persistence failure must not turn
	// an already-computed verdict into a 500 for the caller.
	let verdictId: string | null = null
	let persisted = false
	let persistenceNote: string | undefined
	if (targetActorId) {
		try {
			const recorded = await recordReviewerVerdict({
				db,
				workspaceId: p.workspaceId,
				rubricId: rubric.id,
				targetActorId,
				reviewerActorId: p.actorId,
				reviewerSessionId,
				cycleNumber: 1,
				verdict: verdict.overall,
				criteriaVerdicts: verdict.criteria,
				createdBy: p.actorId,
			})
			verdictId = recorded.id
			persisted = true
		} catch (err) {
			// Caller-input errors (e.g. a target_actor_id that doesn't exist) must
			// surface to the route's error mapping, not be swallowed as a
			// best-effort persistence failure — only genuine write/connectivity
			// failures belong in persistence_note.
			if (err instanceof ReviewerVerdictError) {
				throw err
			}
			logger.error('agent-builder: failed to persist reviewer verdict', {
				workspaceId: p.workspaceId,
				targetActorId,
				error: String(err),
			})
			persistenceNote = `verdict computed but not persisted: ${err instanceof Error ? err.message : String(err)}`
		}
	} else {
		persistenceNote =
			'verdict computed but not persisted — object_id reviews have no associated actor; pass target_actor_id to make this verdict ratable'
	}

	return {
		verdict,
		reviewerSessionId,
		rubricId: rubric.id,
		targetActorId,
		verdictId,
		persisted,
		persistenceNote,
	}
}

/**
 * Composes review + rate + precision-summary behind the single
 * maskin_reviewer_verdict MCP tool. Each piece runs whenever the caller
 * supplied enough to do it — there's no action/mode switch:
 *  - object_id or session_id present → review runs (and persists via
 *    reviewWork, so its verdict_id becomes ratable).
 *  - human_agreed present → rate runs, against verdict_id if given,
 *    otherwise against the verdict this same call just reviewed.
 *  - a rubric resolves (from the review, the rating, or an explicit
 *    rubric_id) → the precision summary is always attached.
 *
 * One constraint callers hit often enough to call out: rating the verdict
 * this same call just reviewed will throw self_rating_forbidden whenever the
 * reviewing and rating identity are the same actor (the common case, since
 * both default to the caller) — that guard is deliberate (see
 * rateReviewerVerdict's doc comment) and this function does not route around
 * it. Pass verdict_id for a verdict produced by a *different* prior caller
 * to actually record a rating.
 */
export async function reviewerVerdictWorkflow(
	db: Database,
	p: {
		workspaceId: string
		actorId: string
		objectId?: string
		sessionId?: string
		targetActorId?: string
		rubricId?: string
		verdictId?: string
		humanAgreed?: boolean
		criteriaDisagreements?: string[]
		note?: string
	},
): Promise<{
	review: Awaited<ReturnType<typeof reviewWork>> | null
	rating: {
		verdictId: string
		humanAgreed: boolean
		humanCriteriaDisagreements: string[] | null
	} | null
	precisionSummary: PrecisionSummary | null
}> {
	if (!p.objectId && !p.sessionId && !p.verdictId && !p.rubricId) {
		throw new AgentReviewTargetError(
			'no_target_specified',
			'Provide at least one of object_id, session_id, verdict_id, or rubric_id.',
		)
	}

	const review =
		p.objectId || p.sessionId
			? await reviewWork(db, {
					workspaceId: p.workspaceId,
					actorId: p.actorId,
					objectId: p.objectId,
					sessionId: p.sessionId,
					rubricId: p.rubricId,
					targetActorId: p.targetActorId,
				})
			: null

	let rating: {
		verdictId: string
		humanAgreed: boolean
		humanCriteriaDisagreements: string[] | null
	} | null = null
	let ratedRubricId: string | null = null
	if (p.humanAgreed !== undefined) {
		const verdictIdForRating = p.verdictId ?? review?.verdictId ?? null
		if (!verdictIdForRating) {
			throw new AgentReviewTargetError(
				'no_verdict_to_rate',
				'human_agreed was provided but no ratable verdict is available — pass verdict_id ' +
					'(from a prior, differently-attributed review), or review via session_id / ' +
					'object_id+target_actor_id so a verdict is persisted first.',
			)
		}
		const rated = await rateReviewerVerdict({
			db,
			workspaceId: p.workspaceId,
			verdictId: verdictIdForRating,
			ratedByActorId: p.actorId,
			humanAgreed: p.humanAgreed,
			criteriaDisagreements: p.criteriaDisagreements,
			note: p.note,
		})
		rating = {
			verdictId: rated.id,
			humanAgreed: rated.humanAgreed,
			humanCriteriaDisagreements: rated.humanCriteriaDisagreements,
		}
		ratedRubricId = rated.rubricId
	}

	const resolvedRubricId = review?.rubricId ?? ratedRubricId ?? p.rubricId ?? null
	const precisionSummary = resolvedRubricId
		? await computeReviewerPrecision({ db, workspaceId: p.workspaceId, rubricId: resolvedRubricId })
		: null

	return { review, rating, precisionSummary }
}

// ── Standalone refine path (maskin_refine_agent) ─────────────────────────────

export class AgentRefineError extends Error {
	constructor(
		readonly reason: 'actor_wrong_workspace' | 'skill_not_found' | 'refine_context_empty',
		message: string,
	) {
		super(message)
		this.name = 'AgentRefineError'
	}
}

/**
 * Refine an existing agent-builder actor in place. Loads the current system
 * prompt + persona summary from the actor, re-runs stages 3 and 4 with the
 * caller's refinement `context` appended as revision feedback, then writes
 * the assembled prompt back to the actor + republishes the SKILL.md.
 *
 * The intent + persona are inferred from the current actor row (we don't
 * store the raw stage-1/2 outputs, so we synthesize a minimal intent from
 * the actor's description and rely on the refinement context to steer the
 * changes). This keeps refinement scoped to prompt authoring — we never
 * rename the actor or change its scope boundaries silently.
 *
 * The actor's current systemPrompt is also passed into stages 3-4 verbatim
 * (see buildPersonaContextMessage's CURRENT SYSTEM PROMPT block) so the model
 * has the actual prior wording to preserve, not just the thin synthesized
 * persona — this is what keeps a narrow refinement request from rewriting
 * unrelated sections. It's a prompt-level constraint, not a structural diff:
 * the model can still stray, but it now has the anchor to hold still against.
 */
export async function refineAgent(
	ctx: AgentBuilderContext,
	p: { actorId: string; context: string },
): Promise<{
	updatedActorId: string
	diff: string
	newSystemPrompt: string
	previousSystemPrompt: string
}> {
	const trimmedContext = p.context.trim()
	if (!trimmedContext) {
		throw new AgentRefineError('refine_context_empty', 'Refinement context is empty')
	}

	const actorRows = await ctx.db
		.select({
			id: actors.id,
			name: actors.name,
			description: actors.description,
			systemPrompt: actors.systemPrompt,
		})
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.where(and(eq(actors.id, p.actorId), eq(workspaceMembers.workspaceId, ctx.workspaceId)))
		.limit(1)
	const actor = actorRows[0]
	if (!actor) {
		throw new AgentRefineError(
			'actor_wrong_workspace',
			`Actor ${p.actorId} not found in workspace ${ctx.workspaceId}`,
		)
	}

	// Look up the workspace_skill attached to this actor via agent_skills. We
	// republish this row's content — refining the actor with no attached skill
	// is out of scope (would need to synthesize a name + slug + description).
	const skillRows = await ctx.db
		.select({
			id: workspaceSkills.id,
			name: workspaceSkills.name,
			description: workspaceSkills.description,
		})
		.from(workspaceSkills)
		.innerJoin(agentSkills, eq(agentSkills.workspaceSkillId, workspaceSkills.id))
		.where(and(eq(agentSkills.actorId, actor.id), eq(workspaceSkills.workspaceId, ctx.workspaceId)))
		.limit(1)
	const skillRow = skillRows[0]
	if (!skillRow) {
		throw new AgentRefineError(
			'skill_not_found',
			`Actor ${p.actorId} has no attached SKILL.md — cannot refine`,
		)
	}

	// Synthesize minimal intent + persona from the actor row. The persona
	// carries enough to feed stages 3 + 4 (name, role headline, delegation
	// description). The refinement context lands as revision feedback.
	const persona: PersonaSpec = {
		name: actor.name,
		role: actor.description?.trim() || `SME agent — ${actor.name}`,
		backstory:
			"Existing agent — refine the sectioned system prompt to reflect the caller's revision feedback while preserving persona identity and scope.",
		scope_boundaries: [],
		delegation_description:
			skillRow.description?.trim() || `Use ${actor.name} when working in its domain.`,
		tool_set: [],
	}
	const intent: Stage1Output = {
		domain: skillRow.description?.trim() || `${actor.name}'s domain`,
		job_to_be_done: `Update ${actor.name}'s definition to reflect the refinement context.`,
		deliverables: [],
		constraints: [],
		is_underspecified: false,
		missing: [],
		gap_question: '',
	}

	const previousSystemPrompt = actor.systemPrompt ?? ''
	const revisionNotes = [`[refinement] ${trimmedContext}`]
	const { sections, opinionation } = await runStages3And4(
		intent,
		persona,
		revisionNotes,
		previousSystemPrompt || undefined,
	)
	const newSystemPrompt = assembleSystemPrompt(persona, sections, opinionation)
	const newSkillMd = assembleSkillMd(skillRow.name, persona, sections, opinionation)
	const sizeBytes = Buffer.byteLength(newSkillMd, 'utf-8')

	// Update in a single transaction so a mid-flight failure leaves the actor
	// and skill on their previous versions. S3 put happens inside so a
	// rejected object rolls back everything.
	let s3PutSucceeded = false
	try {
		await ctx.db.transaction(async (tx) => {
			await tx.update(actors).set({ systemPrompt: newSystemPrompt }).where(eq(actors.id, actor.id))
			await tx
				.update(workspaceSkills)
				.set({ content: newSkillMd, sizeBytes })
				.where(eq(workspaceSkills.id, skillRow.id))
			await ctx.agentStorage.putWorkspaceSkill(ctx.workspaceId, skillRow.id, newSkillMd)
			s3PutSucceeded = true
		})
	} catch (err) {
		if (s3PutSucceeded) {
			logger.error('agent-builder: refine tx-commit failure after S3 put — orphan write', {
				workspaceId: ctx.workspaceId,
				skillId: skillRow.id,
				error: String(err),
			})
		}
		throw new AgentBuilderError(
			'actor_registration_failed',
			err instanceof Error ? err.message : 'DB write failed during agent refine',
		)
	}

	// Audit — fire-and-forget, must not turn a successful commit into a 500.
	try {
		await ctx.db.insert(events).values({
			workspaceId: ctx.workspaceId,
			actorId: ctx.actorId,
			action: 'updated',
			entityType: 'actor',
			entityId: actor.id,
			data: { source: 'agent_builder_refine', refinement_context: trimmedContext.slice(0, 500) },
		})
	} catch (err) {
		logger.warn('agent-builder: refine audit event failed', {
			actorId: actor.id,
			error: String(err),
		})
	}

	return {
		updatedActorId: actor.id,
		diff: summariseRefineDiff(previousSystemPrompt, newSystemPrompt),
		newSystemPrompt,
		previousSystemPrompt,
	}
}

/**
 * Produce a short human-readable summary of what changed between two system
 * prompts. Deliberately simple — the caller (usually the Developer or Code
 * Reviewer) wants a quick "these sections grew / shrank / were added" view,
 * not a full unified diff. If they need the exact diff they can pull both
 * prompts from the actor row + git history.
 */
export function summariseRefineDiff(previous: string, next: string): string {
	if (!previous.trim()) return 'Refine wrote a new system prompt (no previous version to diff).'

	const sectionRe = /^## (.+)$/gm
	const previousSections = new Set(
		Array.from(previous.matchAll(sectionRe))
			.map((m) => (m[1] ?? '').trim())
			.filter(Boolean),
	)
	const nextSections = new Set(
		Array.from(next.matchAll(sectionRe))
			.map((m) => (m[1] ?? '').trim())
			.filter(Boolean),
	)
	const added = [...nextSections].filter((s) => !previousSections.has(s))
	const removed = [...previousSections].filter((s) => !nextSections.has(s))

	const previousLength = previous.length
	const nextLength = next.length
	const pctDelta =
		previousLength > 0 ? Math.round(((nextLength - previousLength) / previousLength) * 100) : 0

	const bits: string[] = []
	if (added.length) bits.push(`added sections: ${added.join(', ')}`)
	if (removed.length) bits.push(`removed sections: ${removed.join(', ')}`)
	bits.push(
		`length changed by ${pctDelta >= 0 ? '+' : ''}${pctDelta}% (${previousLength} → ${nextLength} chars)`,
	)
	return bits.join('; ')
}
