const ASSISTANT_ROLES = new Set(['assistant', 'agent', 'ai', 'bot'])
const MAX_TURN_CHARS = 2000

/**
 * What the assistant said, in order, from a list of {role, text | content | transcript}
 * messages. The message shape is UNVERIFIED against live Telnyx, so anything else is read
 * as "nothing said" rather than guessed at.
 */
export function assistantTurns(messages: unknown): string[] {
	if (!Array.isArray(messages)) return []
	const turns: string[] = []
	for (const raw of messages) {
		const m = raw as Record<string, unknown> | null
		if (!m || typeof m !== 'object') continue
		const role = typeof m.role === 'string' ? m.role.toLowerCase() : ''
		if (!ASSISTANT_ROLES.has(role)) continue
		const said = m.text ?? m.content ?? m.transcript
		if (typeof said === 'string' && said.trim() !== '')
			turns.push(said.trim().slice(0, MAX_TURN_CHARS))
	}
	return turns
}

export function firstAssistantTurn(messages: unknown): string | null {
	return assistantTurns(messages)[0] ?? null
}

export function lastAssistantTurn(messages: unknown): string | null {
	const turns = assistantTurns(messages)
	return turns[turns.length - 1] ?? null
}
