import type { ActivityStep } from '@/components/agents/session-log-transcript'

const WORKING = 'Working'

/** Tools whose plain name can't be guessed from the verb in front of them. */
const TOOL_LABELS: Record<string, string> = {
	post_conversation_message: 'Writing a reply',
	get_comments: 'Reading comments',
	create_comment: 'Writing a comment',
	list_triggers: 'Checking triggers',
	get_trigger: 'Checking triggers',
	Read: 'Reading files',
	Glob: 'Looking through files',
	Grep: 'Looking through files',
	Edit: 'Editing files',
	Write: 'Editing files',
	WebSearch: 'Searching the web',
	WebFetch: 'Reading a web page',
	TodoWrite: 'Planning',
}

/** Verb prefixes that read the same whatever the tool is about. */
const VERB_LABELS: [prefix: string, label: string][] = [
	['get_', 'Looking things up'],
	['list_', 'Looking things up'],
	['search_', 'Looking things up'],
	['create_', 'Saving changes'],
	['update_', 'Saving changes'],
]

function baseToolName(name: string): string {
	if (!name.startsWith('mcp__')) return name
	const rest = name.slice('mcp__'.length)
	const serverEnd = rest.indexOf('__')
	return serverEnd === -1 ? rest : rest.slice(serverEnd + 2)
}

/**
 * A short plain line for what a step is doing, or null when the step should not
 * speak for the agent (its thinking, a shell command, a message from a person).
 * A tool with no friendly name reads "Working" rather than its raw name.
 */
export function plainStepLabel(step: ActivityStep): string | null {
	switch (step.kind) {
		case 'text':
			return 'Writing a reply'
		case 'error':
			return WORKING
		case 'thinking':
		case 'user':
			return null
		case 'tool_use': {
			const tool = baseToolName(step.tool ?? '')
			if (tool.toLowerCase() === 'bash') return null
			const exact = TOOL_LABELS[tool]
			if (exact) return exact
			return VERB_LABELS.find(([prefix]) => tool.startsWith(prefix))?.[1] ?? WORKING
		}
	}
}

/** What the agent is doing now: the latest step that has a plain line, else "Working". */
export function plainActivityLine(steps: ActivityStep[]): string {
	for (let i = steps.length - 1; i >= 0; i--) {
		const label = plainStepLabel(steps[i])
		if (label) return label
	}
	return WORKING
}
