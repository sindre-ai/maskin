import { z } from 'zod'
import type { ResearchEffort } from '../research-cap'

/**
 * The lead's research brief (spec 7.1 step 2): its reading of the question and
 * the subtopics the researchers split between them. Effort sets the range of
 * subtopics (spec 7.2); the lead picks inside it, and code clamps whatever it
 * answers, so a lead that ignores the range cannot start a run of the wrong size.
 */

export interface EffortPlan {
	/** Fewest and most researchers the lead may pick. */
	minResearchers: number
	maxResearchers: number
	/** Most tool calls one researcher may make. */
	maxToolCalls: number
}

export const EFFORT_PLANS: Record<ResearchEffort, EffortPlan> = {
	simple: { minResearchers: 1, maxResearchers: 1, maxToolCalls: 10 },
	comparison: { minResearchers: 2, maxResearchers: 4, maxToolCalls: 15 },
	broad: { minResearchers: 10, maxResearchers: 12, maxToolCalls: 15 },
}

/** At most this many researchers run at the same time (spec 7.1 step 3). */
export const MAX_PARALLEL_RESEARCHERS = 5

const stringList = z.array(z.string().trim().min(1)).default([])

const subtopicSchema = z.object({
	objective: z.string().trim().min(1),
	sub_questions: stringList,
	source_hints: stringList,
	boundaries: z.string().default(''),
	tool_call_limit: z.number().optional(),
})

const briefSchema = z.object({
	interpretation: z.string().trim().min(1),
	subtopics: z.array(z.unknown()).min(1),
})

export interface Subtopic {
	objective: string
	sub_questions: string[]
	source_hints: string[]
	boundaries: string
	tool_call_limit: number
}

export interface ResearchBrief {
	interpretation: string
	subtopics: Subtopic[]
}

/**
 * Parses the lead's reply. Null when it is not the JSON brief at all (there is no
 * repair call). A subtopic that breaks the contract is skipped; more subtopics
 * than the effort allows are cut; a tool-call limit is clamped to 1 to the maximum.
 */
export function parseLeadBrief(text: string | null, plan: EffortPlan): ResearchBrief | null {
	if (!text) return null
	const start = text.indexOf('{')
	const end = text.lastIndexOf('}')
	if (start === -1 || end <= start) return null
	let raw: unknown
	try {
		raw = JSON.parse(text.slice(start, end + 1))
	} catch {
		return null
	}
	const brief = briefSchema.safeParse(raw)
	if (!brief.success) return null

	const subtopics: Subtopic[] = []
	for (const candidate of brief.data.subtopics) {
		const parsed = subtopicSchema.safeParse(candidate)
		if (!parsed.success) continue
		const { tool_call_limit, ...rest } = parsed.data
		const limit = Number.isFinite(tool_call_limit)
			? Math.round(tool_call_limit as number)
			: plan.maxToolCalls
		subtopics.push({
			...rest,
			sub_questions: rest.sub_questions.length > 0 ? rest.sub_questions : [rest.objective],
			tool_call_limit: Math.min(plan.maxToolCalls, Math.max(1, limit)),
		})
		if (subtopics.length === plan.maxResearchers) break
	}
	if (subtopics.length === 0) return null
	return { interpretation: brief.data.interpretation, subtopics }
}
