const DESCRIPTION_MAX = 280
const CREATOR_NAME_MAX = 40

export type AgentIntroInput = {
	agentName: string
	description: string | null
	/** actors.name of the person who gets the hello. */
	recipientName: string
	/** mcpServers keys of the new agent, already without the maskin preset. */
	toolNames: string[]
	agentPageUrl: string
	/** False when the workspace has no usable LLM credentials. */
	canRun: boolean
	createdByAgent: boolean
	/** Only read when createdByAgent is true. */
	creatorName: string
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

function openingLine(input: AgentIntroInput): string {
	const firstName = firstNameOf(input.recipientName)
	const greeting = firstName
		? `Hey ${firstName}, I'm ${input.agentName}.`
		: `Hi, I'm ${input.agentName}.`

	const creatorName = input.createdByAgent ? cap(input.creatorName, CREATOR_NAME_MAX) : ''
	const creatorLine = creatorName ? ` ${creatorName} set me up for you.` : ''

	const description = input.description?.trim()
		? cap(input.description, DESCRIPTION_MAX)
		: "I'm new here and don't have a description yet."
	return `${greeting}${creatorLine} ${description}`
}

/** The fallback when the full intro cannot be built: name and description only. */
export function renderMinimalAgentIntro(input: AgentIntroInput): string {
	return openingLine(input)
}

/**
 * The static intro a new agent posts into the 1-1 with the person it was made
 * for. Pure: no model call, no database. Plain voice, no em dashes, no backticks.
 */
export function renderAgentIntro(input: AgentIntroInput): string {
	const firstJob = input.canRun
		? 'Give me a first job. Reply here with a task, or @mention me on a bet or task.'
		: "I can't run yet. Connect your Claude subscription or API key under Settings, Keys, then reply here."
	const tools = input.toolNames.length > 0 ? input.toolNames.join(', ') : 'none yet'

	const lines = [
		openingLine(input),
		'Three ways to get me going:',
		`1. ${firstJob}`,
		`2. Check what I can use. Tools: ${tools}. Skills: none yet, you can add some on my agent page (${input.agentPageUrl}).`,
		'3. Want me on a schedule? Ask me to set one up, or add a trigger on my agent page.',
	]
	// An agent that was set up by another agent may already have a job, so the
	// "nothing runs" line would be false for it.
	if (!input.createdByAgent) {
		lines.push('I only start work when you ask, so nothing runs until you reply.')
	}
	lines.push("I'll reply here. Only things that need your decision go to For You.")
	return lines.join('\n')
}
