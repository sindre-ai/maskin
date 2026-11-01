import { describe, expect, it } from 'vitest'
import { EFFORT_PLANS, parseLeadBrief } from '../../../lib/research/lead'

const subtopic = (n: number, over: Record<string, unknown> = {}) => ({
	objective: `Topic ${n}`,
	sub_questions: [`What about ${n}?`],
	source_hints: ['official documentation'],
	boundaries: `Not topic ${n + 1}`,
	tool_call_limit: 8,
	...over,
})

const brief = (subtopics: unknown[], interpretation = 'Compare the options.') =>
	JSON.stringify({ interpretation, subtopics })

describe('EFFORT_PLANS', () => {
	it('matches the effort table: 1, 2 to 4 and 10 to 12 researchers, tool calls per researcher', () => {
		expect(EFFORT_PLANS.simple).toMatchObject({
			minResearchers: 1,
			maxResearchers: 1,
			maxToolCalls: 10,
		})
		expect(EFFORT_PLANS.comparison).toMatchObject({
			minResearchers: 2,
			maxResearchers: 4,
			maxToolCalls: 15,
		})
		expect(EFFORT_PLANS.broad).toMatchObject({
			minResearchers: 10,
			maxResearchers: 12,
			maxToolCalls: 15,
		})
	})
})

describe('parseLeadBrief', () => {
	it('reads the brief with subtopics, boundaries and tool-call limits', () => {
		const out = parseLeadBrief(brief([subtopic(1), subtopic(2)]), EFFORT_PLANS.comparison)
		expect(out?.interpretation).toBe('Compare the options.')
		expect(out?.subtopics).toHaveLength(2)
		expect(out?.subtopics[0]).toEqual({
			objective: 'Topic 1',
			sub_questions: ['What about 1?'],
			source_hints: ['official documentation'],
			boundaries: 'Not topic 2',
			tool_call_limit: 8,
		})
	})

	it('finds the JSON inside a code fence or surrounding prose', () => {
		const out = parseLeadBrief(
			`Here is the brief:\n\`\`\`json\n${brief([subtopic(1), subtopic(2)])}\n\`\`\``,
			EFFORT_PLANS.comparison,
		)
		expect(out?.subtopics).toHaveLength(2)
	})

	it('returns null when the reply is not the brief', () => {
		expect(parseLeadBrief(null, EFFORT_PLANS.comparison)).toBeNull()
		expect(parseLeadBrief('I will research this.', EFFORT_PLANS.comparison)).toBeNull()
		expect(parseLeadBrief('{"interpretation":"x"}', EFFORT_PLANS.comparison)).toBeNull()
		expect(
			parseLeadBrief('{"interpretation":"x","subtopics":[]}', EFFORT_PLANS.comparison),
		).toBeNull()
		expect(parseLeadBrief('{not json}', EFFORT_PLANS.comparison)).toBeNull()
	})

	it('cuts subtopics beyond what the effort allows', () => {
		const six = [1, 2, 3, 4, 5, 6].map((n) => subtopic(n))
		expect(parseLeadBrief(brief(six), EFFORT_PLANS.comparison)?.subtopics).toHaveLength(4)
		const fifteen = Array.from({ length: 15 }, (_, n) => subtopic(n))
		expect(parseLeadBrief(brief(fifteen), EFFORT_PLANS.broad)?.subtopics).toHaveLength(12)
	})

	it('clamps a tool-call limit to 1 up to the effort maximum, and defaults a missing one', () => {
		const out = parseLeadBrief(
			brief([
				subtopic(1, { tool_call_limit: 500 }),
				subtopic(2, { tool_call_limit: 0 }),
				subtopic(3, { tool_call_limit: undefined }),
			]),
			EFFORT_PLANS.comparison,
		)
		expect(out?.subtopics.map((s) => s.tool_call_limit)).toEqual([15, 1, 15])
	})

	it('skips a subtopic that breaks the contract and keeps the rest', () => {
		const out = parseLeadBrief(
			brief([subtopic(1), { objective: '' }, 'nonsense', subtopic(2)]),
			EFFORT_PLANS.comparison,
		)
		expect(out?.subtopics.map((s) => s.objective)).toEqual(['Topic 1', 'Topic 2'])
	})

	it('falls back to the objective when there are no sub-questions', () => {
		const out = parseLeadBrief(brief([subtopic(1, { sub_questions: [] })]), EFFORT_PLANS.comparison)
		expect(out?.subtopics[0]?.sub_questions).toEqual(['Topic 1'])
	})
})
