import { randomUUID } from 'node:crypto'
import type { Database, Transaction } from '@maskin/db'
import { events, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { logger } from '../lib/logger'
import { type LlmCallInput, callLlm } from './llm-call'

// Fresh-context reviewer for the agent builder.
//
// Isolation rationale: T1's architecture decision rejected `run_agent` sessions
// for the pipeline stages because a 60s+ microVM boot per call blows the 30s
// p95 budget. The bet's reviewer requirement is `run_agent`-shaped only so far
// as isolation goes — the Cognition finding it cites is that producer and
// reviewer sharing context lead to rubber-stamping. That property is preserved
// by making the reviewer LLM call from a *cold* callLlm() invocation whose
// only inputs are the assembled definition text and the rubric content: no
// prior turns, no intermediate producer outputs, no shared conversation.
// This keeps the tool contract (sync response, ≤15s p95) intact.
//
// If a future revision decides the reviewer needs a full container session for
// tool use (e.g. rubric that reads other workspace objects), switch this file
// to a `run_agent`-shaped call — every caller goes through `runAgentReviewer`.

const REVIEWER_TEMPERATURE = 0.1
const REVIEWER_TIMEOUT_MS = 20_000
const REVIEWER_MAX_TOKENS = 1400

// Canonical rubric type — one object per workspace. Kept as a workspace object
// (per bet DoD) so humans edit criteria via update_objects without a code
// deploy. Bootstrapped from `DEFAULT_RUBRIC_BODY` on first use if absent.
export const RUBRIC_OBJECT_TYPE = 'agent_builder_rubric'
export const CANONICAL_RUBRIC_TITLE = 'Agent builder — reviewer rubric'

// PostHog + `events.action` name — kept as a single constant so the bet's
// `metadata.posthog_query` dashboard and any SSE consumers can't drift.
export const REVIEWER_VERDICT_SUBMITTED = 'reviewer_verdict_submitted'

// Named rubric criteria the builder's revision loop pattern-matches on.
// Order is not load-bearing; the reviewer LLM is free to add extras (extra
// criteria are surfaced in the verdict but never gate a revision beyond
// their own pass/fail).
export const RUBRIC_CRITERIA_NAMES = [
	'persona_specificity',
	'opinionation_scaffolding_present',
	'worked_examples_at_least_two',
	'no_hedging_enforcement',
	'scope_boundaries_named',
] as const

export type RubricCriterionName = (typeof RUBRIC_CRITERIA_NAMES)[number]

// Default rubric body written into the workspace on first reviewer run. The
// language is intentionally concrete about what makes a criterion pass so a
// low-temperature reviewer can score it deterministically. Humans can edit
// this by updating the workspace object's content.
export const DEFAULT_RUBRIC_BODY = `# Agent builder reviewer rubric

Score each criterion below as pass or fail. A single failing criterion means overall = "fail" and the builder will re-run stages 3-4 with your \`fix\` notes appended to the persona context. Be concrete in fix notes — name the specific section, the specific sentence, or the specific missing element.

## Criteria

- **persona_specificity** — The persona has a named role, a stated backstory that encodes at least one named framework the agent uses to decide, and at least one named blind spot / bias. A generic "expert in X" backstory FAILS. A one-line role with no framework FAILS.
- **opinionation_scaffolding_present** — The system prompt contains a \`## Response protocol\` section (or equivalent) that literally requires "Recommendation:" and "Assumptions:" lines in every in-domain response. The absence of that scaffolding — or scaffolding that is optional, hedged, or aspirational — FAILS.
- **worked_examples_at_least_two** — The definition includes at least two worked examples (ask + response pairs) that follow the Recommendation / Assumptions shape themselves. Fewer than two FAILS. Examples that hedge in their own response FAILS.
- **no_hedging_enforcement** — The system prompt explicitly forbids hedging language ("might", "could", "it depends") in the closing recommendation block. If forbidding language is absent, or is present as a suggestion rather than a directive, FAILS.
- **scope_boundaries_named** — Scope boundaries are stated as concrete things the agent will and will NOT engage with (topics, adjacent domains, out-of-scope asks). "General expert" or "any question in X" FAILS.

## Output contract

Return STRICT JSON matching this shape (no prose, no code fences):

\`\`\`json
{
  "criteria": [
    { "name": "persona_specificity", "pass": true, "fix": "" },
    { "name": "opinionation_scaffolding_present", "pass": false, "fix": "Add a Response protocol section that requires every in-domain response to end with \\"Recommendation:\\" and \\"Assumptions:\\" lines." },
    { "name": "worked_examples_at_least_two", "pass": true, "fix": "" },
    { "name": "no_hedging_enforcement", "pass": true, "fix": "" },
    { "name": "scope_boundaries_named", "pass": true, "fix": "" }
  ],
  "overall": "fail"
}
\`\`\`

Overall must be "pass" only when every criterion passes. When a criterion fails, \`fix\` must be a specific, actionable instruction the producer can use to revise the definition. Empty \`fix\` is fine when the criterion passes.`

const criterionSchema = z.object({
	name: z.string().min(1),
	pass: z.boolean(),
	fix: z.string().default(''),
})

const verdictSchema = z.object({
	criteria: z.array(criterionSchema).min(1),
	overall: z.enum(['pass', 'fail']),
})

export type ReviewerVerdict = z.infer<typeof verdictSchema>
export type ReviewerCriterion = z.infer<typeof criterionSchema>

export class AgentReviewerError extends Error {
	constructor(
		readonly reason: 'llm_no_api_key' | 'llm_http_error' | 'llm_exception' | 'reviewer_parse_error',
		message: string,
	) {
		super(message)
		this.name = 'AgentReviewerError'
	}
}

const REVIEWER_SYSTEM_PROMPT = `You are the agent-builder reviewer. You score a draft SME-agent definition against a rubric and return a structured verdict.

Your context is deliberately empty. You did NOT author this draft, you have NO shared conversation with the producer, and you will NOT be told anything about how it was made. This is by design — self-review from the producing model rubber-stamps output. Score only what you see.

The user message you receive has exactly two sections:

- \`## RUBRIC\` — the criteria you must score against, and the exact JSON output contract.
- \`## DEFINITION\` — the draft agent definition (system prompt + worked examples). Score THIS.

Rules:
- Follow the rubric's output contract exactly — return STRICT JSON with the fields the rubric specifies. No prose, no code fences, no commentary.
- A criterion passes ONLY when the rubric's description is satisfied. If in doubt, FAIL and write a specific \`fix\`.
- \`overall\` = "pass" only when every criterion passes. Any single failing criterion means \`overall\` = "fail".
- A \`fix\` note must be a concrete instruction ("Add a section on X", "The bias statement is generic — name at least one specific blind spot the domain has"). Vague notes ("improve", "make better") are useless.
- Never invent extra rubric fields the contract doesn't ask for.`

function buildReviewerUserMessage(rubricBody: string, definitionText: string): string {
	return ['## RUBRIC', '', rubricBody.trim(), '', '## DEFINITION', '', definitionText.trim()].join(
		'\n',
	)
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

function safeParseJson(raw: string): unknown {
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

/**
 * Run one fresh-context reviewer pass. `reviewerSessionId` is generated per
 * call and returned in the verdict envelope so downstream event emission can
 * correlate the reviewer run to the outer pipeline attempt.
 */
export async function runAgentReviewer(input: {
	definitionText: string
	rubricBody: string
}): Promise<{ verdict: ReviewerVerdict; reviewerSessionId: string; rawResponse: string }> {
	const reviewerSessionId = randomUUID()
	const params: LlmCallInput = {
		system: REVIEWER_SYSTEM_PROMPT,
		user: buildReviewerUserMessage(input.rubricBody, input.definitionText),
		temperature: REVIEWER_TEMPERATURE,
		maxTokens: REVIEWER_MAX_TOKENS,
		timeoutMs: REVIEWER_TIMEOUT_MS,
		jsonMode: true,
	}

	const result = await callLlm(params)
	if (!result.ok) {
		if (result.reason === 'no_api_key') {
			throw new AgentReviewerError('llm_no_api_key', 'reviewer: LLM key not configured')
		}
		if (result.reason === 'http_error') {
			throw new AgentReviewerError(
				'llm_http_error',
				`reviewer: LLM returned HTTP ${result.status ?? 'unknown'}`,
			)
		}
		throw new AgentReviewerError('llm_exception', 'reviewer: LLM request failed')
	}

	const parsed = verdictSchema.safeParse(safeParseJson(result.content))
	if (!parsed.success) {
		logger.error('reviewer: verdict parse failed', {
			issues: parsed.error.issues,
			rawPreview: result.content.slice(0, 300),
			reviewerSessionId,
		})
		throw new AgentReviewerError(
			'reviewer_parse_error',
			'reviewer: LLM returned invalid verdict JSON shape',
		)
	}

	return { verdict: parsed.data, reviewerSessionId, rawResponse: result.content }
}

type DbHandle = Database | Transaction

/**
 * Get the canonical workspace rubric object. Bootstraps a default rubric on
 * first call for a workspace so the reviewer always has something to score
 * against — humans can then edit that object's content to change criteria.
 *
 * Bootstrap creator: the workspace's first membership row's actor. If there's
 * no member (shouldn't happen for a live workspace), falls back to
 * `fallbackActorId` — the caller who tripped the bootstrap.
 */
export async function getOrBootstrapCanonicalRubric(
	db: DbHandle,
	workspaceId: string,
	fallbackActorId: string,
): Promise<{ id: string; content: string }> {
	const rows = await db
		.select({ id: objects.id, content: objects.content, title: objects.title })
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, RUBRIC_OBJECT_TYPE)))
		.limit(1)

	const existing = rows[0]
	if (existing) {
		// A workspace can have zero or one canonical rubric today. If a human
		// clears the content field, fall back to the default so the reviewer
		// still has something to score against — but don't overwrite their edits
		// silently.
		const content = existing.content?.trim() ? existing.content : DEFAULT_RUBRIC_BODY
		return { id: existing.id, content }
	}

	const inserted = await db
		.insert(objects)
		.values({
			workspaceId,
			type: RUBRIC_OBJECT_TYPE,
			title: CANONICAL_RUBRIC_TITLE,
			content: DEFAULT_RUBRIC_BODY,
			status: 'active',
			createdBy: fallbackActorId,
		})
		.returning({ id: objects.id })
	const created = inserted[0]
	if (!created) {
		// Insert without a returned row is a Drizzle contract violation — fall
		// through with a synthetic id would silently break downstream reads.
		throw new Error('agent-reviewer: rubric bootstrap INSERT returned no row')
	}
	return { id: created.id, content: DEFAULT_RUBRIC_BODY }
}

export async function resolveRubricById(
	db: DbHandle,
	workspaceId: string,
	rubricId: string,
): Promise<{ id: string; content: string } | null> {
	const rows = await db
		.select({ id: objects.id, content: objects.content, workspaceId: objects.workspaceId })
		.from(objects)
		.where(eq(objects.id, rubricId))
		.limit(1)
	const row = rows[0]
	if (!row || row.workspaceId !== workspaceId) return null
	const content = row.content?.trim() ? row.content : DEFAULT_RUBRIC_BODY
	return { id: row.id, content }
}

/**
 * Emit the `reviewer_verdict_submitted` event. Two paths:
 *  - `events` table row (audit + PG NOTIFY → SSE feed, same pattern as
 *    workspace_knowledge_referenced),
 *  - PostHog capture (feeds the bet's `metadata.posthog_query` dashboard).
 *
 * Both are best-effort. A failed audit or PostHog call must never surface
 * to the caller — the reviewer verdict is already computed.
 */
export async function trackReviewerVerdictSubmitted(
	db: DbHandle,
	p: {
		workspaceId: string
		actorId: string
		targetActorId: string | null
		rubricId: string
		overall: 'pass' | 'fail'
		cycleNumber: number
		reviewerSessionId: string
		failingCriteria: string[]
	},
): Promise<void> {
	try {
		await db.insert(events).values({
			workspaceId: p.workspaceId,
			actorId: p.actorId,
			action: REVIEWER_VERDICT_SUBMITTED,
			// entityType/entityId anchor the SSE feed to the reviewed actor
			// when one exists, so the agent-detail view can subscribe to its own
			// verdict stream without a workspace-wide fanout.
			entityType: p.targetActorId ? 'actor' : 'object',
			entityId: p.targetActorId ?? p.rubricId,
			data: {
				overall: p.overall,
				cycle_number: p.cycleNumber,
				reviewer_session_id: p.reviewerSessionId,
				rubric_id: p.rubricId,
				failing_criteria: p.failingCriteria,
				target_actor_id: p.targetActorId,
			},
		})
	} catch (err) {
		logger.warn('reviewer_verdict_submitted DB insert failed', {
			actorId: p.actorId,
			reviewerSessionId: p.reviewerSessionId,
			error: String(err),
		})
	}

	// PostHog properties are scalar-only per PosthogEventProps — the failing
	// criteria list ships as a comma-joined string plus a count so the
	// dashboard can group without exploding the property cardinality.
	await capturePosthogEvent(REVIEWER_VERDICT_SUBMITTED, p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.targetActorId,
		caller_actor_id: p.actorId,
		overall: p.overall,
		cycle_number: p.cycleNumber,
		reviewer_session_id: p.reviewerSessionId,
		rubric_id: p.rubricId,
		failing_criteria: p.failingCriteria.join(','),
		failing_criteria_count: p.failingCriteria.length,
	})
}

export function failingCriteriaNames(verdict: ReviewerVerdict): string[] {
	return verdict.criteria.filter((c) => !c.pass).map((c) => c.name)
}
