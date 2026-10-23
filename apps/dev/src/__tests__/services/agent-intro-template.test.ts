import { describe, expect, it } from 'vitest'
import {
	type AgentIntroInput,
	type IntroStep,
	buildSuggestedSteps,
	renderAgentIntro,
	renderMinimalAgentIntro,
} from '../../services/agent-intro-template'

const base: AgentIntroInput = {
	agentName: 'Scout',
	description: 'I keep an eye on competitor launches.',
	recipientName: 'Sam Rivers',
	createdByAgent: false,
	creatorName: '',
	canRun: true,
}

const STEPS_LINE = 'How can I help? Start with one of these, or tell me what you need.'
const NO_KEY_LINE =
	"I can't run yet. Connect your Claude subscription or API key under Settings, Keys, then reply here."
const CLOSING = "Reply here whenever you're ready."
const TOOLS_TAIL = "Add any that aren't connected yet under Settings, Integrations."

const send = (label: string): IntroStep => ({ label, prompt: label, action: 'send' })
const fill = (label: string): IntroStep => ({ label, prompt: `${label}: `, action: 'fill' })

function paragraphs(text: string): string[] {
	return text.split('\n\n')
}

function allVariants(): string[] {
	const steps = [send('Read my inbox'), fill('Draft a reply'), send('Who needs a reply?')]
	return [
		renderAgentIntro(base).content,
		renderAgentIntro({ ...base, description: null }).content,
		renderAgentIntro({ ...base, canRun: false }).content,
		renderAgentIntro({ ...base, description: 'x'.repeat(2000) }).content,
		renderAgentIntro({ ...base, recipientName: 'sam@example.com' }).content,
		renderAgentIntro({ ...base, createdByAgent: true, creatorName: 'Chief of Staff' }).content,
		renderAgentIntro({ ...base, createdByAgent: true, creatorName: '' }).content,
		renderAgentIntro({ ...base, creatorSteps: steps }).content,
		renderAgentIntro({ ...base, neededToolNames: ['Linear', 'Gmail', 'Slack'] }).content,
		renderAgentIntro({ ...base, creatorSteps: steps, neededToolNames: ['Linear'] }).content,
	]
}

describe('buildSuggestedSteps', () => {
	it('gives the two generic steps when the creator wrote none', () => {
		expect(buildSuggestedSteps({ canRun: true })).toEqual([
			{ label: 'What can you help me with?', prompt: 'What can you help me with?', action: 'send' },
			{ label: 'Give me a first task', prompt: 'Here is a first task for you: ', action: 'fill' },
		])
	})

	it("puts the creator's steps first and keeps only the generic help step after them", () => {
		const steps = buildSuggestedSteps({
			creatorSteps: [send('Read my inbox'), fill('Draft a reply')],
			canRun: true,
		})
		expect(steps.map((s) => s.label)).toEqual([
			'Read my inbox',
			'Draft a reply',
			'What can you help me with?',
		])
	})

	it('keeps at most 3 creator steps so the generic step always fits, and 4 in all', () => {
		const steps = buildSuggestedSteps({
			creatorSteps: [send('One'), send('Two'), send('Three'), send('Four')],
			canRun: true,
		})
		expect(steps.map((s) => s.label)).toEqual(['One', 'Two', 'Three', 'What can you help me with?'])
	})

	it('drops a later step whose label repeats an earlier one, ignoring case', () => {
		const steps = buildSuggestedSteps({
			creatorSteps: [send('what can you help me with?'), send('Read my inbox')],
			canRun: true,
		})
		expect(steps.map((s) => s.label)).toEqual(['what can you help me with?', 'Read my inbox'])
	})

	it('returns nothing when the workspace cannot run an agent', () => {
		expect(buildSuggestedSteps({ creatorSteps: [send('Read my inbox')], canRun: false })).toEqual(
			[],
		)
	})

	it('adds a fill step per skill after the generic steps while there is room', () => {
		const steps = buildSuggestedSteps({ skillNames: ['Triage', 'Digest', 'Extra'], canRun: true })
		expect(steps).toEqual([
			{ label: 'What can you help me with?', prompt: 'What can you help me with?', action: 'send' },
			{ label: 'Give me a first task', prompt: 'Here is a first task for you: ', action: 'fill' },
			{ label: 'Try Triage', prompt: 'Use Triage on: ', action: 'fill' },
			{ label: 'Try Digest', prompt: 'Use Digest on: ', action: 'fill' },
		])
	})

	it('has no tool step, so a typical web-created agent gets exactly the two generic steps', () => {
		expect(buildSuggestedSteps({ canRun: true }).map((s) => s.label)).toEqual([
			'What can you help me with?',
			'Give me a first task',
		])
	})
})

describe('renderAgentIntro', () => {
	it('orders greeting and description, steps line, numbered list, closing line', () => {
		const { content } = renderAgentIntro(base)
		expect(paragraphs(content)).toEqual([
			"Hey Sam, I'm Scout. I keep an eye on competitor launches.",
			STEPS_LINE,
			'1. What can you help me with?\n2. Give me a first task',
		])
	})

	it('omits the description when there is none', () => {
		for (const description of [null, '', '   ']) {
			expect(paragraphs(renderAgentIntro({ ...base, description }).content)[0]).toBe(
				"Hey Sam, I'm Scout.",
			)
		}
	})

	it('caps a long description at 240 characters', () => {
		const first =
			paragraphs(renderAgentIntro({ ...base, description: 'x'.repeat(2000) }).content)[0] ?? ''
		expect(first.length).toBeLessThan(270)
		expect(first.endsWith('…')).toBe(true)
	})

	it('uses a nameless greeting when the recipient name holds an @', () => {
		const first = paragraphs(
			renderAgentIntro({ ...base, recipientName: 'sam@example.com' }).content,
		)[0]
		expect(first).toBe("Hi, I'm Scout. I keep an eye on competitor launches.")
	})

	it('puts the creator line right after the greeting when an agent set it up', () => {
		const { content } = renderAgentIntro({
			...base,
			createdByAgent: true,
			creatorName: 'Chief of Staff',
		})
		expect(paragraphs(content)[0]).toBe(
			"Hey Sam, I'm Scout. Chief of Staff set me up for you. I keep an eye on competitor launches.",
		)
	})

	it('cuts a long creator name to 30 characters', () => {
		const first =
			paragraphs(
				renderAgentIntro({ ...base, createdByAgent: true, creatorName: 'C'.repeat(100) }).content,
			)[0] ?? ''
		expect(first).toContain(`${'C'.repeat(30)}… set me up for you.`)
		expect(first).not.toContain('C'.repeat(31))
	})

	it('leaves the creator line out when the creator name is empty', () => {
		const first = paragraphs(
			renderAgentIntro({ ...base, createdByAgent: true, creatorName: '  ' }).content,
		)[0]
		expect(first).toBe("Hey Sam, I'm Scout. I keep an eye on competitor launches.")
	})

	it('ignores the creator name for a human-created agent', () => {
		const { content } = renderAgentIntro({
			...base,
			createdByAgent: false,
			creatorName: 'Chief of Staff',
		})
		expect(content).not.toContain('set me up for you')
	})

	it("leads the numbered list with the creator's labels", () => {
		const { content, steps } = renderAgentIntro({
			...base,
			creatorSteps: [send('Read my inbox'), fill('Draft a reply')],
		})
		expect(paragraphs(content)[2]).toBe(
			'1. Read my inbox\n2. Draft a reply\n3. What can you help me with?',
		)
		expect(steps).toHaveLength(3)
	})

	it('names the needed tools in one neutral sentence: one, two and three names', () => {
		const sentence = (names: string[]) =>
			paragraphs(renderAgentIntro({ ...base, neededToolNames: names }).content).find((p) =>
				p.startsWith('For this job I use'),
			)
		expect(sentence(['Linear'])).toBe(`For this job I use Linear. ${TOOLS_TAIL}`)
		expect(sentence(['Linear', 'Gmail'])).toBe(`For this job I use Linear and Gmail. ${TOOLS_TAIL}`)
		expect(sentence(['Linear', 'Gmail', 'Slack'])).toBe(
			`For this job I use Linear, Gmail and Slack. ${TOOLS_TAIL}`,
		)
	})

	it('shows at most 3 tool names and cuts a fourth', () => {
		const rendered = renderAgentIntro({
			...base,
			neededToolNames: ['Linear', 'Gmail', 'Slack', 'GitHub'],
		})
		expect(rendered.neededToolNames).toEqual(['Linear', 'Gmail', 'Slack'])
		expect(rendered.content).not.toContain('GitHub')
	})

	it('has no tools sentence when no tool is needed', () => {
		expect(renderAgentIntro(base).content).not.toContain('For this job I use')
	})

	it('swaps the steps for the connect-a-key line when there are no usable credentials', () => {
		const rendered = renderAgentIntro({
			...base,
			canRun: false,
			creatorSteps: [send('Read my inbox')],
			neededToolNames: ['Linear'],
		})
		expect(paragraphs(rendered.content)).toEqual([
			"Hey Sam, I'm Scout. I keep an eye on competitor launches.",
			NO_KEY_LINE,
		])
		expect(rendered.steps).toEqual([])
		expect(rendered.neededToolNames).toEqual([])
		expect(rendered.plainTailCount).toBe(0)
	})

	describe('plainTailCount', () => {
		it('counts the list and the closing line when the list ends in a question', () => {
			const rendered = renderAgentIntro(base)
			// The generic steps end in "Give me a first task", so no closing line here.
			expect(rendered.plainTailCount).toBe(1)
			const withCreator = renderAgentIntro({ ...base, creatorSteps: [send('Read my inbox')] })
			// Creator steps end on the generic help step, a question, so a closing line follows.
			expect(withCreator.plainTailCount).toBe(2)
			expect(paragraphs(withCreator.content).slice(-2)[1]).toBe(CLOSING)
		})

		it('counts the list and the tools sentence, and no closing line, when the tools sentence ends it', () => {
			const rendered = renderAgentIntro({
				...base,
				creatorSteps: [send('Read my inbox')],
				neededToolNames: ['Linear'],
			})
			expect(rendered.plainTailCount).toBe(2)
			expect(rendered.content).not.toContain(CLOSING)
		})
	})

	describe('the last character', () => {
		it('is never a question mark, in any variant', () => {
			for (const text of allVariants()) {
				expect(text.trimEnd().endsWith('?')).toBe(false)
			}
		})

		it('closes with the closing line when the list ends in a question', () => {
			const { content } = renderAgentIntro({ ...base, creatorSteps: [send('Read my inbox')] })
			expect(content.endsWith(`\n\n${CLOSING}`)).toBe(true)
		})

		it('does not add the closing line when the list already ends on a statement', () => {
			expect(renderAgentIntro(base).content).not.toContain(CLOSING)
		})
	})

	it('never emits a backtick or an em dash', () => {
		for (const text of allVariants()) {
			expect(text).not.toContain('`')
			expect(text).not.toContain('—')
		}
	})
})

describe('renderMinimalAgentIntro', () => {
	it('is the opening line only', () => {
		expect(renderMinimalAgentIntro(base)).toBe(
			"Hey Sam, I'm Scout. I keep an eye on competitor launches.",
		)
		expect(
			renderMinimalAgentIntro({ ...base, createdByAgent: true, creatorName: 'Chief of Staff' }),
		).toBe(
			"Hey Sam, I'm Scout. Chief of Staff set me up for you. I keep an eye on competitor launches.",
		)
	})
})
