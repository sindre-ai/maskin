import { describe, expect, it } from 'vitest'
import {
	AGENT_BUILDER_RESULT_MARKER,
	SELF_CRITIQUE_SKILL_NAME,
	buildAgentBuilderActionPrompt,
	parseAgentBuilderResult,
	selfCritiqueSkillContent,
} from '../../services/agent-builder-bootstrap'
import { RUBRIC_CRITERIA_NAMES } from '../../services/agent-reviewer'

describe('selfCritiqueSkillContent', () => {
	it('names every rubric criterion — guards against drift from agent-reviewer.ts', () => {
		const content = selfCritiqueSkillContent()
		for (const name of RUBRIC_CRITERIA_NAMES) {
			expect(content).toContain(name)
		}
	})

	it('serializes with the expected skill name in frontmatter', () => {
		const content = selfCritiqueSkillContent()
		expect(content).toMatch(new RegExp(`^---\\nname: ${SELF_CRITIQUE_SKILL_NAME}\\n`))
	})

	it('states the one-revision cap', () => {
		const content = selfCritiqueSkillContent()
		expect(content).toMatch(/revise.*ONCE/i)
	})
})

describe('buildAgentBuilderActionPrompt', () => {
	const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111'

	it('includes the literal workspace id and the one-liner', () => {
		const prompt = buildAgentBuilderActionPrompt({
			prompt: 'plan a launch',
			workspaceId: WORKSPACE_ID,
		})
		expect(prompt).toContain(`WORKSPACE_ID: ${WORKSPACE_ID}`)
		expect(prompt).toContain('ONE-LINER: plan a launch')
	})

	it('folds in examples, references, and constraints when supplied', () => {
		const prompt = buildAgentBuilderActionPrompt({
			prompt: 'plan a launch',
			workspaceId: WORKSPACE_ID,
			examples: ['example one'],
			references: ['https://example.com'],
			constraints: ['no budget over $10k'],
		})
		expect(prompt).toContain('EXAMPLES:\n- example one')
		expect(prompt).toContain('REFERENCES:\n- https://example.com')
		expect(prompt).toContain('CONSTRAINTS:\n- no budget over $10k')
	})

	it('omits optional sections entirely when not supplied', () => {
		const prompt = buildAgentBuilderActionPrompt({
			prompt: 'plan a launch',
			workspaceId: WORKSPACE_ID,
		})
		expect(prompt).not.toContain('EXAMPLES:')
		expect(prompt).not.toContain('REFERENCES:')
		expect(prompt).not.toContain('CONSTRAINTS:')
	})
})

describe('AGENT_BUILDER_RESULT_MARKER', () => {
	it('is a stable, non-empty marker string the builder system prompt embeds', async () => {
		const { BUILDER_SYSTEM_PROMPT } = await import('../../services/agent-builder-bootstrap')
		expect(AGENT_BUILDER_RESULT_MARKER).toBeTruthy()
		expect(BUILDER_SYSTEM_PROMPT).toContain(AGENT_BUILDER_RESULT_MARKER)
	})
})

describe('parseAgentBuilderResult', () => {
	const CREATED_JSON = {
		kind: 'created',
		actor_id: '11111111-1111-1111-1111-111111111111',
		actor_name: 'Migration Architect',
		skill_id: '22222222-2222-2222-2222-222222222222',
		skill_name: 'migration-architect',
		definition_summary: 'Migration Architect — plans schema migrations.',
		self_critique: { revised: true, rounds: 1 },
		gap_report_object_id: '33333333-3333-3333-3333-333333333333',
		gap_report_items: [
			{
				topic: 'scale',
				detail: 'row counts unknown',
				why_it_matters: 'sizes the migration window',
			},
		],
		gap_report_comment_posted: true,
	}

	const GAP_QUESTION_JSON = {
		kind: 'gap_question',
		gap_question: 'What domain should this agent work in?',
		missing: ['domain'],
	}

	function fenced(payload: unknown): string {
		return `Some narration.\n\n\`\`\`json ${AGENT_BUILDER_RESULT_MARKER}\n${JSON.stringify(payload)}\n\`\`\`\n`
	}

	it('parses a valid "created" result out of a fenced block', () => {
		const parsed = parseAgentBuilderResult(fenced(CREATED_JSON))
		expect(parsed).toEqual(CREATED_JSON)
	})

	it('parses a valid "gap_question" result out of a fenced block', () => {
		const parsed = parseAgentBuilderResult(fenced(GAP_QUESTION_JSON))
		expect(parsed).toEqual(GAP_QUESTION_JSON)
	})

	it('returns null when no fenced marker block is present', () => {
		expect(parseAgentBuilderResult('The session finished but hit an error.')).toBeNull()
	})

	it('returns null when the fence uses a different marker', () => {
		const wrongMarker = `\`\`\`json some_other_marker\n${JSON.stringify(CREATED_JSON)}\n\`\`\``
		expect(parseAgentBuilderResult(wrongMarker)).toBeNull()
	})

	it('returns null on malformed JSON inside the fence', () => {
		const broken = `\`\`\`json ${AGENT_BUILDER_RESULT_MARKER}\n{ not valid json\n\`\`\``
		expect(parseAgentBuilderResult(broken)).toBeNull()
	})

	it('returns null when the JSON does not match either output-contract shape', () => {
		const wrongShape = fenced({ kind: 'created', actor_id: 'not-a-uuid' })
		expect(parseAgentBuilderResult(wrongShape)).toBeNull()
	})

	it('ignores prose before and after the fenced block', () => {
		const withTrailingProse = `${fenced(CREATED_JSON)}\nThanks for using the agent builder!`
		expect(parseAgentBuilderResult(withTrailingProse)).toEqual(CREATED_JSON)
	})

	it('accepts gap_report_object_id: null when the gap-report object could not be created', () => {
		const withoutGapReportObject = { ...CREATED_JSON, gap_report_object_id: null }
		expect(parseAgentBuilderResult(fenced(withoutGapReportObject))).toEqual(withoutGapReportObject)
	})
})
