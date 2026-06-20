import type { ChatMessage } from '@/lib/chat-store'
import { buildOneShotActionPrompt } from '@/lib/sindre-selection'
import type {
	SindreSelectionFile,
	SindreSelectionNotification,
	SindreSelectionObject,
} from '@/lib/sindre-selection'
import type { SindreEvent } from '@/lib/sindre-stream'

/**
 * Each agent reply runs as a fresh, stateless one-shot session, so the agent
 * has no memory of the conversation. To make the chat feel multiplayer we
 * replay a compact transcript into the action_prompt: who's in the room, what
 * everyone (humans + other agents) has said, and the new message addressed to
 * this agent. The agent then answers in its own voice.
 */

export interface BuildChatPromptArgs {
	/** The agent this prompt is for. */
	targetAgentName: string
	/** Names of every participant (humans + agents) for room context. */
	participantNames: string[]
	/** Prior messages in the conversation, oldest first (excludes the new turn). */
	history: ChatMessage[]
	/** The user's current message text. */
	userName: string
	userMessage: string
	/** Attached context from `@`/`/` selection. */
	objects?: SindreSelectionObject[]
	notifications?: SindreSelectionNotification[]
	files?: SindreSelectionFile[]
}

const MAX_HISTORY_MESSAGES = 30

export function buildChatTurnPrompt(args: BuildChatPromptArgs): string {
	const {
		targetAgentName,
		participantNames,
		history,
		userName,
		userMessage,
		objects = [],
		notifications = [],
		files = [],
	} = args

	const others = participantNames.filter((n) => n !== targetAgentName)
	const roster =
		others.length > 0
			? `You are "${targetAgentName}" in a group chat with ${joinNames(others)}.`
			: `You are "${targetAgentName}" in a chat with ${userName}.`

	const lines: string[] = [
		roster,
		'Reply only as yourself, in your own voice. Do not speak for other participants or prefix your reply with your name. Keep the multiplayer context in mind — another participant may have already answered.',
		'',
		'--- Conversation so far ---',
	]

	const recent = history.slice(-MAX_HISTORY_MESSAGES)
	if (recent.length === 0) {
		lines.push('(no earlier messages)')
	} else {
		for (const message of recent) {
			const speaker = message.senderName
			const body =
				message.role === 'user' ? message.text.trim() : agentMessageText(message.events).trim()
			if (body.length === 0) continue
			lines.push(`${speaker}: ${body}`)
		}
	}

	lines.push('--- End conversation ---', '')

	const turn = buildOneShotActionPrompt(userMessage, objects, notifications, files)
	lines.push(`${userName} says: ${turn}`)

	return lines.join('\n')
}

function joinNames(names: string[]): string {
	if (names.length === 1) return names[0]
	if (names.length === 2) return `${names[0]} and ${names[1]}`
	return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

/** Flattens an agent message's streamed events into plain text for the replay. */
function agentMessageText(events: SindreEvent[]): string {
	return events
		.filter((e): e is Extract<SindreEvent, { kind: 'text' }> => e.kind === 'text')
		.map((e) => e.text)
		.join('')
}
