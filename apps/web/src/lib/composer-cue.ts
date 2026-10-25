import type { ConversationParticipantResponse, MessageResponse } from '@/lib/api'
import { MESSAGE_MAX_MENTIONS, decideWakes } from '@maskin/shared'

// The composer cue: the placeholder and one hint line that say who will answer a
// group-chat message, or that nobody will. The words are formatting only. Who is
// woken comes from the same decideWakes the server runs, so the two cannot drift.

/** Placeholder while nothing can be said yet, and when nobody will answer. */
export const NEUTRAL_PLACEHOLDER = 'Message this conversation'
export const HINT_PEOPLE_ONLY = 'Only people are tagged, so no agent will reply.'
export const HINT_NOBODY = 'No agent will reply. Tag one with @.'

/** Active participants from 3 up are a group chat; below that the old text stays. */
const GROUP_MIN_PARTICIPANTS = 3

export interface ComposerCue {
	placeholder: string
	/** Null when there is nothing to say under the box. */
	hint: string | null
}

type CuePerson = Pick<ConversationParticipantResponse, 'actorId' | 'actorName' | 'actorType'>

export interface ComposerCueInput {
	selfId: string
	/** Active participants of the chat, the sender included. */
	participants: readonly CuePerson[]
	/**
	 * Agents tagged in the box who are not in the chat yet. The server adds them before it
	 * decides who wakes, so they count for the decision but not for the 3-participant gate.
	 */
	joiningAgents?: readonly CuePerson[]
	/** Actor ids picked with @ in the box, in pick order. */
	taggedIds: readonly string[]
	/**
	 * What the thread has loaded, oldest first. Null while it is still loading or failed.
	 * Ignored on a chat that does not exist yet.
	 */
	messages: readonly Pick<MessageResponse, 'actorId' | 'actorType' | 'kind'>[] | null
	/** True when older pages exist that are not loaded. */
	hasMoreMessages: boolean
	/** A chat that does not exist yet (the new-chat screen): no messages, first message. */
	isNewChat?: boolean
}

/**
 * The cue for the box right now, or null when the cue does not apply (fewer than 3 active
 * participants), in which case the caller keeps today's text. While a needed input is
 * still missing the cue is the neutral placeholder and no hint, and the server decides.
 */
export function deriveComposerCue(input: ComposerCueInput): ComposerCue | null {
	const { selfId, participants } = input
	if (participants.length < GROUP_MIN_PARTICIPANTS) return null

	const everyone = [...participants, ...(input.joiningAgents ?? [])]
	const names = new Map(everyone.map((p) => [p.actorId, p.actorName]))

	// What the message would carry: the same filter and cap the send path applies.
	const mentions = input.taggedIds.filter((id) => id !== selfId).slice(0, MESSAGE_MAX_MENTIONS)

	let previousOther: { authorId: string; authorType: 'human' | 'agent' } | null = null
	let isFirstMessage = false
	if (input.isNewChat) {
		isFirstMessage = true
	} else {
		if (input.messages === null) return neutral()
		const real = input.messages.filter((m) => m.kind === 'message')
		for (let i = real.length - 1; i >= 0; i--) {
			const m = real[i]
			if (m.actorId === selfId) continue
			previousOther = {
				authorId: m.actorId,
				authorType: m.actorType === 'agent' ? 'agent' : 'human',
			}
			break
		}
		// Older pages might still hold the last other writer, or an earlier message that
		// makes this not the first one. Never guess a name or call the chat new.
		if (!previousOther && input.hasMoreMessages) return neutral()
		isFirstMessage = real.length === 0 && !input.hasMoreMessages
	}

	const decision = decideWakes({
		author: { id: selfId, type: 'human' },
		mentions,
		participants: everyone.map((p) => ({
			id: p.actorId,
			// A participant that is not clearly an agent counts as a person, so the cue
			// never promises a wake.
			type: p.actorType === 'agent' ? 'agent' : 'human',
		})),
		previousOther,
		isFirstMessage,
		// A person's message resets the run of agent replies, so the cap never applies here.
		consecutiveAgentTail: 0,
		maxConsecutiveAgents: 5,
	})

	const woken = decision.wakes.map((w) => names.get(w.agentId) ?? 'an agent')
	if (woken.length === 1) return { placeholder: `Reply to ${woken[0]}…`, hint: null }
	if (woken.length === 2)
		return { placeholder: `Reply to ${woken[0]} and ${woken[1]}…`, hint: null }
	if (woken.length > 2) return { placeholder: `Reply to ${woken.length} agents…`, hint: null }
	return {
		placeholder: NEUTRAL_PLACEHOLDER,
		hint: mentions.length > 0 ? HINT_PEOPLE_ONLY : HINT_NOBODY,
	}
}

function neutral(): ComposerCue {
	return { placeholder: NEUTRAL_PLACEHOLDER, hint: null }
}
