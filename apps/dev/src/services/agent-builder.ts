import { z } from 'zod'
import { logger } from '../lib/logger'
import { callLlm } from './llm-call'

// Six-stage `maskin_create_agent` pipeline. This file ships stages 1 and 2:
//   Stage 1 — parse the user's one-liner into structured intent, and detect
//             when the input is too vague to produce a useful persona.
//   Stage 2 — synthesise a named, opinionated SME persona from the parsed
//             intent. Only runs when Stage 1 flags the input as well-specified.
//
// Stage sequencing (important for the p95 <30s budget):
//   Stages 1 and 2 are strictly sequential — stage 2 consumes stage 1's
//   output, and stage 1 gates the early-return on underspecified input.
//   There's no Promise.all opportunity inside T2 alone. Later stages added
//   in T3/T4 (e.g. system-prompt authoring vs. opinionation-layer authoring)
//   are candidates for parallelism if they don't consume each other's output;
//   flag those seams then, not now.
//
// Both stages call the LLM at temperature ≤0.3 (per bet's parameter contract).
// Underspecified inputs are surfaced as a `gap_question` — never a hallucinated
// fill for the missing field.

const STAGE_1_TEMPERATURE = 0.2
const STAGE_2_TEMPERATURE = 0.3
const STAGE_1_MAX_TOKENS = 600
const STAGE_2_MAX_TOKENS = 1200
const STAGE_1_TIMEOUT_MS = 5_000
const STAGE_2_TIMEOUT_MS = 15_000

export const STAGE_1_PROMPT = `You extract structured intent from a single-line request to create a domain-expert AI agent.

Return a strict JSON object with these fields:
- domain: string — the professional field (e.g. "SEO consulting", "clinical trial design"). Empty string if not clearly implied.
- job_to_be_done: string — the specific task the agent should perform (e.g. "audit landing pages for on-page SEO"). Empty string if not clearly implied.
- deliverables: string[] — concrete artefacts the agent produces (e.g. ["prioritised issue list", "before/after checklist"]). Empty array if none implied.
- constraints: string[] — explicit limits from the request (budget, scope, tools, timeline). Empty array if none.
- is_underspecified: boolean — true when EITHER domain OR job_to_be_done cannot be inferred with high confidence. Do NOT guess: if the request is a bare noun ("marketing"), a vague verb ("help me"), or references an unnamed context ("do the thing"), set true.
- gap_question: string — when is_underspecified is true, ONE short question that would elicit the missing mandatory field. Empty string when is_underspecified is false. Format as a direct question a human would answer in one sentence.

Rules:
- Never invent a domain or job that isn't in the input. Underspecification is a valid outcome — the gap question is the correct response for vague prompts.
- Keep every string field under 200 characters.
- Return ONLY the JSON object — no prose, no code fences.`

export const STAGE_2_PROMPT = `You design a named, opinionated subject-matter-expert AI agent from a structured intent object.

Given the parsed intent, return a strict JSON object describing the persona:
- name: string — a specific human-sounding name (first name + optional last initial, or a professional handle). Never a generic label like "The Assistant" or "AI Helper".
- role: string — a specific job title (e.g. "Senior on-page SEO auditor", not "SEO expert").
- backstory: string — 3-5 sentences that encode: (1) concrete expertise (years, prior roles, notable engagements), (2) a decision-making framework this expert applies (a named methodology, a heuristic they trust, or a specific evaluation order), (3) at least two NAMED biases or blind spots they own (e.g. "biased toward measurable wins over brand plays", "distrusts vanity metrics"). The backstory must give the agent a POINT OF VIEW, not just a resume.
- scope_boundaries: string[] — 2-5 topics this agent refuses or defers on (e.g. "does not advise on paid ads", "will not write JavaScript"). Precise, not generic.
- delegation_description: string — a single sentence starting with "Use this agent when..." that names when a human or orchestrator should route work to this persona.
- tool_set: string[] — inferred minimal set of tool names this persona needs to do its job (e.g. ["read_url", "search_web", "create_report"]). Use short snake_case identifiers. Prefer 3-6 tools; never zero.

Rules:
- Every field must be OPINIONATED — no hedging ("might", "could potentially", "in some cases"). If the intent doesn't support an opinionated answer, still commit to one based on the domain conventions.
- The backstory MUST include at least two named biases/blind spots — this is what makes the agent useful vs. generic.
- Return ONLY the JSON object — no prose, no code fences.`

const stage1SchemaRaw = z.object({
	domain: z.string(),
	job_to_be_done: z.string(),
	deliverables: z.array(z.string()).default([]),
	constraints: z.array(z.string()).default([]),
	is_underspecified: z.boolean(),
	gap_question: z.string().default(''),
})

export type Stage1Intent = z.infer<typeof stage1SchemaRaw>

const stage2SchemaRaw = z.object({
	name: z.string().min(1),
	role: z.string().min(1),
	backstory: z.string().min(1),
	scope_boundaries: z.array(z.string()).default([]),
	delegation_description: z.string().min(1),
	tool_set: z.array(z.string()).default([]),
})

export type Stage2Persona = z.infer<typeof stage2SchemaRaw>

export interface AgentBuilderInput {
	prompt: string
	examples?: string[]
	references?: string[]
	constraints?: string[]
}

export type AgentBuilderResult =
	| {
			status: 'underspecified'
			gap_question: string
			intent: Stage1Intent
	  }
	| {
			status: 'ok'
			intent: Stage1Intent
			persona: Stage2Persona
	  }
	| {
			status: 'error'
			reason:
				| 'llm_unavailable'
				| 'stage_1_failed'
				| 'stage_1_parse_error'
				| 'stage_2_failed'
				| 'stage_2_parse_error'
			message: string
	  }

function buildStage1UserMessage(input: AgentBuilderInput): string {
	const lines: string[] = [`Request: ${input.prompt.trim()}`]
	if (input.examples && input.examples.length > 0) {
		lines.push(`Examples the requester provided: ${input.examples.join(' | ')}`)
	}
	if (input.references && input.references.length > 0) {
		lines.push(`References: ${input.references.join(' | ')}`)
	}
	if (input.constraints && input.constraints.length > 0) {
		lines.push(`Additional constraints: ${input.constraints.join(' | ')}`)
	}
	return lines.join('\n')
}

function buildStage2UserMessage(input: AgentBuilderInput, intent: Stage1Intent): string {
	return JSON.stringify(
		{
			original_request: input.prompt,
			intent: {
				domain: intent.domain,
				job_to_be_done: intent.job_to_be_done,
				deliverables: intent.deliverables,
				constraints: intent.constraints,
			},
			examples: input.examples ?? [],
			references: input.references ?? [],
		},
		null,
		2,
	)
}

function tryParseJson(raw: string): unknown | null {
	// Strip a markdown fence if the model produced one anyway.
	const cleaned = raw
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/```\s*$/i, '')
		.trim()
	try {
		return JSON.parse(cleaned)
	} catch {
		return null
	}
}

export async function runStage1(input: AgentBuilderInput): Promise<
	| { ok: true; intent: Stage1Intent }
	| {
			ok: false
			reason: 'llm_unavailable' | 'stage_1_failed' | 'stage_1_parse_error'
			message: string
	  }
> {
	const llm = await callLlm({
		system: STAGE_1_PROMPT,
		user: buildStage1UserMessage(input),
		temperature: STAGE_1_TEMPERATURE,
		maxTokens: STAGE_1_MAX_TOKENS,
		timeoutMs: STAGE_1_TIMEOUT_MS,
		jsonMode: true,
		callerTag: 'agent-builder.stage1',
	})
	if (!llm.ok) {
		if (llm.reason === 'no_api_key') {
			return {
				ok: false,
				reason: 'llm_unavailable',
				message: 'MASKIN_FALLBACK_OPENROUTER_KEY is not configured on the server.',
			}
		}
		return {
			ok: false,
			reason: 'stage_1_failed',
			message: `Stage 1 LLM call failed: ${llm.reason}`,
		}
	}
	const parsed = tryParseJson(llm.content)
	const validated = stage1SchemaRaw.safeParse(parsed)
	if (!validated.success) {
		logger.warn('agent-builder.stage1: parse error', { issues: validated.error.issues })
		return {
			ok: false,
			reason: 'stage_1_parse_error',
			message: 'Stage 1 output did not match the expected JSON shape.',
		}
	}
	return { ok: true, intent: validated.data }
}

export async function runStage2(
	input: AgentBuilderInput,
	intent: Stage1Intent,
): Promise<
	| { ok: true; persona: Stage2Persona }
	| {
			ok: false
			reason: 'stage_2_failed' | 'stage_2_parse_error' | 'llm_unavailable'
			message: string
	  }
> {
	const llm = await callLlm({
		system: STAGE_2_PROMPT,
		user: buildStage2UserMessage(input, intent),
		temperature: STAGE_2_TEMPERATURE,
		maxTokens: STAGE_2_MAX_TOKENS,
		timeoutMs: STAGE_2_TIMEOUT_MS,
		jsonMode: true,
		callerTag: 'agent-builder.stage2',
	})
	if (!llm.ok) {
		if (llm.reason === 'no_api_key') {
			return {
				ok: false,
				reason: 'llm_unavailable',
				message: 'MASKIN_FALLBACK_OPENROUTER_KEY is not configured on the server.',
			}
		}
		return {
			ok: false,
			reason: 'stage_2_failed',
			message: `Stage 2 LLM call failed: ${llm.reason}`,
		}
	}
	const parsed = tryParseJson(llm.content)
	const validated = stage2SchemaRaw.safeParse(parsed)
	if (!validated.success) {
		logger.warn('agent-builder.stage2: parse error', { issues: validated.error.issues })
		return {
			ok: false,
			reason: 'stage_2_parse_error',
			message: 'Stage 2 output did not match the expected JSON shape.',
		}
	}
	return { ok: true, persona: validated.data }
}

export async function runAgentBuilder(input: AgentBuilderInput): Promise<AgentBuilderResult> {
	const stage1 = await runStage1(input)
	if (!stage1.ok) {
		return { status: 'error', reason: stage1.reason, message: stage1.message }
	}

	if (stage1.intent.is_underspecified) {
		const gap = stage1.intent.gap_question.trim()
		// Guardrail: if the model flagged underspecified but forgot to include a
		// question, fall back to a generic prompt for the missing mandatory field.
		const gap_question =
			gap.length > 0 ? gap : 'What specific domain and outcome should this agent focus on?'
		return { status: 'underspecified', gap_question, intent: stage1.intent }
	}

	const stage2 = await runStage2(input, stage1.intent)
	if (!stage2.ok) {
		return { status: 'error', reason: stage2.reason, message: stage2.message }
	}

	return { status: 'ok', intent: stage1.intent, persona: stage2.persona }
}
