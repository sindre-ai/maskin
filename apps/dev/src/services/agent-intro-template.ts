import type { FirstStep } from '@maskin/shared'

const DESCRIPTION_MAX = 240
const CREATOR_NAME_MAX = 30
const MAX_STEPS = 4
const MAX_CREATOR_STEPS = 3
const MAX_NEEDED_TOOLS = 3

const STEPS_LINE = 'How can I help? Start with one of these, or tell me what you need.'
const NO_STEPS_LINE = "How can I help? Tell me what you need and I'll get started."
const NO_KEY_LINE =
	"I can't run yet. Connect your Claude subscription or API key under Settings, Keys, then reply here."
// The iPhone app adds Yes and No buttons under any message that ends in a
// question mark, so the body must close on a statement.
const CLOSING_LINE = "Reply here whenever you're ready."

export type IntroStep = Pick<FirstStep, 'label' | 'prompt' | 'action'>

const GENERIC_HELP_STEP: IntroStep = {
	label: 'What can you help me with?',
	prompt: 'What can you help me with?',
	action: 'send',
}
const GENERIC_FIRST_TASK_STEP: IntroStep = {
	label: 'Give me a first task',
	prompt: 'Here is a first task for you: ',
	action: 'fill',
}

/**
 * The first steps shown in the intro, in order: the creator's (at most 3), then
 * "What can you help me with?", then, only when the creator wrote none, "Give me
 * a first task", then one fill step per skill name while there is room. A new
 * agent has no skills, so the skill steps never fire at creation. Deduplicated by
 * lowercase label, at most 4. Nothing when the workspace cannot run an agent.
 * This is the single ordering rule for the steps.
 */
export function buildSuggestedSteps(input: {
	creatorSteps?: IntroStep[]
	skillNames?: string[]
	canRun: boolean
}): IntroStep[] {
	if (!input.canRun) return []
	const creatorSteps = (input.creatorSteps ?? []).slice(0, MAX_CREATOR_STEPS)
	const skillSteps = (input.skillNames ?? []).map(
		(name): IntroStep => ({ label: `Try ${name}`, prompt: `Use ${name} on: `, action: 'fill' }),
	)
	const candidates = [
		...creatorSteps,
		GENERIC_HELP_STEP,
		...(creatorSteps.length === 0 ? [GENERIC_FIRST_TASK_STEP] : []),
		...skillSteps,
	]
	const seen = new Set<string>()
	const steps: IntroStep[] = []
	for (const step of candidates) {
		const key = step.label.trim().toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		steps.push(step)
		if (steps.length === MAX_STEPS) break
	}
	return steps
}

export type AgentIntroInput = {
	agentName: string
	description: string | null
	/** actors.name of the person who gets the hello. */
	recipientName: string
	createdByAgent: boolean
	/** Only read when createdByAgent is true. */
	creatorName: string
	/** False when the workspace has no usable LLM credentials. */
	canRun: boolean
	/** The creator's first_steps, as passed on the create call. */
	creatorSteps?: IntroStep[]
	/** Display names of the integrations the agent needs, already filtered to the catalog. */
	neededToolNames?: string[]
}

export type RenderedIntro = {
	content: string
	/** The steps the list shows, so the caller can count them and Slice 5a can store them. */
	steps: IntroStep[]
	/** The tool names the sentence shows (at most 3). */
	neededToolNames: string[]
	/** How many trailing paragraphs are plain text only: the list, the tools sentence, the closing line. */
	plainTailCount: number
}

function cap(text: string, max: number): string {
	const trimmed = text.trim()
	if (trimmed.length <= max) return trimmed
	return `${trimmed.slice(0, max).trimEnd()}…`
}

/** First whitespace-separated word of the name, or null when it holds an @ (an email). */
function firstNameOf(name: string): string | null {
	const trimmed = name.trim()
	if (!trimmed || trimmed.includes('@')) return null
	return trimmed.split(/\s+/)[0] ?? null
}

function joinNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? ''
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Greeting, then the creator line when an agent set this one up, then the description if there is one. */
function openingLine(input: AgentIntroInput): string {
	const firstName = firstNameOf(input.recipientName)
	const parts = [
		firstName ? `Hey ${firstName}, I'm ${input.agentName}.` : `Hi, I'm ${input.agentName}.`,
	]
	const creatorName = input.createdByAgent ? cap(input.creatorName, CREATOR_NAME_MAX) : ''
	if (creatorName) parts.push(`${creatorName} set me up for you.`)
	if (input.description?.trim()) parts.push(cap(input.description, DESCRIPTION_MAX))
	return parts.join(' ')
}

/** The fallback when the full intro cannot be built: greeting, creator line and description only. */
export function renderMinimalAgentIntro(input: AgentIntroInput): string {
	return openingLine(input)
}

/**
 * The static intro a new agent posts into the 1-1 with the person it was made
 * for. Pure: no model call, no database. Plain voice, no em dashes, no backticks.
 * Paragraphs, in order: opening, the steps line (or the connect-a-
 * key line), a numbered list of the step labels, one neutral tools sentence, and
 * a closing line only when the body would otherwise end in a question mark. The
 * body reads complete with no buttons drawn.
 */
export function renderAgentIntro(input: AgentIntroInput): RenderedIntro {
	const steps = buildSuggestedSteps({ creatorSteps: input.creatorSteps, canRun: input.canRun })
	const neededToolNames = input.canRun
		? (input.neededToolNames ?? []).slice(0, MAX_NEEDED_TOOLS)
		: []

	const head = [openingLine(input)]
	if (!input.canRun) {
		head.push(NO_KEY_LINE)
	} else {
		head.push(steps.length > 0 ? STEPS_LINE : NO_STEPS_LINE)
	}

	const tail: string[] = []
	if (steps.length > 0) {
		tail.push(steps.map((step, i) => `${i + 1}. ${step.label}`).join('\n'))
	}
	if (neededToolNames.length > 0) {
		tail.push(
			`For this job I use ${joinNames(neededToolNames)}. Add any that aren't connected yet under Settings, Integrations.`,
		)
	}
	const last = tail[tail.length - 1] ?? head[head.length - 1] ?? ''
	if (last.trimEnd().endsWith('?')) tail.push(CLOSING_LINE)

	// Blank lines between the blocks: the chat renders markdown, where a line right
	// under the list would be read as part of the last item.
	return {
		content: [...head, ...tail].join('\n\n'),
		steps,
		neededToolNames,
		plainTailCount: tail.length,
	}
}
