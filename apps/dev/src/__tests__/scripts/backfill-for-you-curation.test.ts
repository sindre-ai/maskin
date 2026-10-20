import { CHIEF_OF_STAFF_DEFAULT, FOR_YOU_FORMAT_SKILL } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import {
	parseArgs,
	patchChiefOfStaffPrompt,
	patchForYouSkill,
} from '../../../scripts/backfill-for-you-curation'

const template = CHIEF_OF_STAFF_DEFAULT.systemPrompt

const OLD_PROMPT = [
	'# Role',
	'You are the Chief of Staff. A custom line the owner added.',
	'',
	'# For You feed',
	'Score attention from the user point of view. Use 5 only for real blockers.',
	'',
	'# Replies',
	'Short, lead with the result.',
	'',
	'# Onboarding a new workspace (details elsewhere)',
	'Welcome first.',
].join('\n')

describe('backfill-for-you-curation parseArgs', () => {
	const id = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa'

	it('requires an explicit workspace and defaults to a dry run', () => {
		expect(() => parseArgs(['node', 's.ts'])).toThrow(/required/)
		expect(parseArgs(['node', 's.ts', `--workspace-id=${id}`])).toEqual({
			workspaceId: id,
			apply: false,
		})
	})

	it('only applies with --apply, and refuses --all', () => {
		expect(parseArgs(['node', 's.ts', `--workspace-id=${id}`, '--apply']).apply).toBe(true)
		expect(() => parseArgs(['node', 's.ts', `--workspace-id=${id}`, '--all'])).toThrow(/--all/)
		expect(() => parseArgs(['node', 's.ts', '--workspace-id=nope'])).toThrow(/Invalid/)
	})
})

describe('patchChiefOfStaffPrompt', () => {
	it('replaces the For You section and adds the questions section, keeping the rest', () => {
		const { prompt, changed } = patchChiefOfStaffPrompt(OLD_PROMPT, template)
		expect(changed).toBe(true)
		expect(prompt).toContain('# For You list')
		expect(prompt).not.toContain('# For You feed')
		expect(prompt).toContain('# Questions from other agents')
		expect(prompt).toContain('A custom line the owner added.')
		expect(prompt).toContain('Short, lead with the result.')
		expect(prompt).toContain('Welcome first.')
	})

	it('puts the questions section before the onboarding section', () => {
		const { prompt } = patchChiefOfStaffPrompt(OLD_PROMPT, template)
		expect(prompt.indexOf('# Questions from other agents')).toBeLessThan(
			prompt.indexOf('# Onboarding a new workspace'),
		)
	})

	it('is idempotent', () => {
		const once = patchChiefOfStaffPrompt(OLD_PROMPT, template).prompt
		const twice = patchChiefOfStaffPrompt(once, template)
		expect(twice.changed).toBe(false)
		expect(twice.prompt).toBe(once)
	})

	it('appends the sections to a prompt that has neither', () => {
		const { prompt } = patchChiefOfStaffPrompt('# Role\nOnly this.', template)
		expect(prompt.startsWith('# Role\nOnly this.')).toBe(true)
		expect(prompt).toContain('# For You list')
		expect(prompt).toContain('# Questions from other agents')
	})

	it('reports no change when the current prompt is already the template', () => {
		expect(patchChiefOfStaffPrompt(template, template).changed).toBe(false)
	})
})

const EXTENDED_SKILL = [
	'---',
	'name: for-you-format',
	'---',
	'',
	'# For You item format',
	'',
	"You are an agent writing one item for the human's For You queue. It exists only because a decision is blocked on the human.",
	'',
	'Before you write one, load **ask-an-agent-first**. Humans are the last resort.',
	'',
	'**Asked first** — one line, which agents you asked before coming here.',
].join('\n')

describe('patchForYouSkill', () => {
	it("inserts the escalation paragraph and keeps a workspace's own additions", () => {
		const { plan, content } = patchForYouSkill(EXTENDED_SKILL)
		expect(plan).toBe('update')
		expect(content).toContain('Escalate to the Chief of Staff')
		expect(content).toContain('load **ask-an-agent-first**')
		expect(content).toContain('**Asked first**')
		expect(content.indexOf('Escalate to the Chief of Staff')).toBeLessThan(
			content.indexOf('Before you write one'),
		)
	})

	it('is idempotent', () => {
		const once = patchForYouSkill(EXTENDED_SKILL).content
		expect(patchForYouSkill(once)).toEqual({ plan: 'none', content: once })
	})

	it('leaves the current template alone, skips an unrecognised skill, reports a missing one', () => {
		expect(patchForYouSkill(FOR_YOU_FORMAT_SKILL.content).plan).toBe('none')
		expect(patchForYouSkill('# my own version of this skill').plan).toBe('skipped-customised')
		expect(patchForYouSkill(null).plan).toBe('missing')
	})
})
