import { describe, expect, it } from 'vitest'
import {
	type AgentIntroInput,
	renderAgentIntro,
	renderMinimalAgentIntro,
} from '../../services/agent-intro-template'

const base: AgentIntroInput = {
	agentName: 'Scout',
	description: 'I keep an eye on competitor launches.',
	recipientName: 'Sam Rivers',
	toolNames: ['github', 'slack'],
	agentPageUrl: 'https://maskin.io/ws/agents/a1',
	canRun: true,
	createdByAgent: false,
	creatorName: '',
}

const NOTHING_RUNS = 'I only start work when you ask, so nothing runs until you reply.'
const PROMISE = "I'll reply here. Only things that need your decision go to For You."

function allVariants(): string[] {
	return [
		renderAgentIntro(base),
		renderAgentIntro({ ...base, description: null }),
		renderAgentIntro({ ...base, canRun: false }),
		renderAgentIntro({ ...base, description: 'x'.repeat(2000) }),
		renderAgentIntro({ ...base, recipientName: 'sam@example.com' }),
		renderAgentIntro({ ...base, createdByAgent: true, creatorName: 'Chief of Staff' }),
		renderAgentIntro({ ...base, createdByAgent: true, creatorName: '' }),
		renderAgentIntro({ ...base, toolNames: [] }),
	]
}

describe('renderAgentIntro', () => {
	it('greets by first name, shows the description, tools and agent page link', () => {
		const text = renderAgentIntro(base)
		expect(text.split('\n')[0]).toBe("Hey Sam, I'm Scout. I keep an eye on competitor launches.")
		expect(text).toContain('Three ways to get me going:')
		expect(text).toContain('1. Give me a first job.')
		expect(text).toContain(
			'Tools: github, slack. Skills: none yet, you can add some on my agent page (https://maskin.io/ws/agents/a1).',
		)
		expect(text).toContain(NOTHING_RUNS)
		expect(text.endsWith(PROMISE)).toBe(true)
	})

	it('puts a blank line between the greeting, the three ways and the closing lines', () => {
		const text = renderAgentIntro(base)
		expect(text).toContain('\n\nThree ways to get me going:\n1. ')
		expect(text).toContain(`on my agent page.\n\n${NOTHING_RUNS}`)
	})

	it('falls back to a plain line when the description is null or blank', () => {
		for (const description of [null, '', '   ']) {
			expect(renderAgentIntro({ ...base, description }).split('\n')[0]).toBe(
				"Hey Sam, I'm Scout. I'm new here and don't have a description yet.",
			)
		}
	})

	it('swaps item 1 for the connect-a-key line when there are no usable credentials', () => {
		const text = renderAgentIntro({ ...base, canRun: false })
		expect(text).toContain(
			"1. I can't run yet. Connect your Claude subscription or API key under Settings, Keys, then reply here.",
		)
		expect(text).not.toContain('Give me a first job.')
		expect(text.endsWith(PROMISE)).toBe(true)
	})

	it('caps a long description', () => {
		const first = renderAgentIntro({ ...base, description: 'x'.repeat(2000) }).split('\n')[0] ?? ''
		expect(first.length).toBeLessThan(400)
		expect(first.endsWith('…')).toBe(true)
	})

	it('uses a nameless greeting when the recipient name holds an @', () => {
		const first = renderAgentIntro({ ...base, recipientName: 'sam@example.com' }).split('\n')[0]
		expect(first).toBe("Hi, I'm Scout. I keep an eye on competitor launches.")
	})

	it('adds the creator line right after the greeting and drops the nothing-runs line', () => {
		const text = renderAgentIntro({ ...base, createdByAgent: true, creatorName: 'Chief of Staff' })
		expect(text.split('\n')[0]).toBe(
			"Hey Sam, I'm Scout. Chief of Staff set me up for you. I keep an eye on competitor launches.",
		)
		expect(text).not.toContain(NOTHING_RUNS)
		expect(text.endsWith(PROMISE)).toBe(true)
	})

	it('cuts a long creator name to 40 characters', () => {
		const first =
			renderAgentIntro({ ...base, createdByAgent: true, creatorName: 'C'.repeat(100) }).split(
				'\n',
			)[0] ?? ''
		expect(first).toContain(`${'C'.repeat(40)}… set me up for you.`)
		expect(first).not.toContain('C'.repeat(41))
	})

	it('omits the creator line when the creator name is empty, but still drops the nothing-runs line', () => {
		const text = renderAgentIntro({ ...base, createdByAgent: true, creatorName: '  ' })
		expect(text).not.toContain('set me up for you')
		expect(text).not.toContain(NOTHING_RUNS)
		expect(text.split('\n')[0]).toBe("Hey Sam, I'm Scout. I keep an eye on competitor launches.")
	})

	it('ignores the creator name for a human-created agent', () => {
		const text = renderAgentIntro({ ...base, createdByAgent: false, creatorName: 'Chief of Staff' })
		expect(text).not.toContain('set me up for you')
		expect(text).toContain(NOTHING_RUNS)
	})

	it('says so when the agent has no tools beyond the platform one', () => {
		expect(renderAgentIntro({ ...base, toolNames: [] })).toContain('Tools: none yet. Skills:')
	})

	it('has a minimal fallback with just the opening line', () => {
		expect(renderMinimalAgentIntro(base)).toBe(
			"Hey Sam, I'm Scout. I keep an eye on competitor launches.",
		)
		expect(
			renderMinimalAgentIntro({ ...base, createdByAgent: true, creatorName: 'Chief of Staff' }),
		).toBe(
			"Hey Sam, I'm Scout. Chief of Staff set me up for you. I keep an eye on competitor launches.",
		)
	})

	it('never emits a backtick or an em dash', () => {
		for (const text of allVariants()) {
			expect(text).not.toContain('`')
			expect(text).not.toContain('—')
		}
	})
})
