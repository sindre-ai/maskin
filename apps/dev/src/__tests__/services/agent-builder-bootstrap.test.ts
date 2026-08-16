import { describe, expect, it } from 'vitest'
import {
	AGENT_BUILDER_RESULT_MARKER,
	SELF_CRITIQUE_SKILL_NAME,
	buildAgentBuilderActionPrompt,
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
