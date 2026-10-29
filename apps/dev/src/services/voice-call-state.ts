import type { Database } from '@maskin/db'
import { type ForYouItem, buildForYouItems } from '../lib/for-you-items'
import { logger } from '../lib/logger'

/**
 * The little a Live call keeps in memory for its closing receipt: the cards the person had when the
 * call began, the first card the call named, and the hold still waiting for a yes. Everything else
 * the closing receipt says is read back from the saved receipt rows, so a server restart loses
 * only these three (and the receipt then writes "unknown", it never guesses).
 *
 * In-process, like liveCalls in voice-realtime-call.ts: a call's socket and its write gate live in
 * the one server process that accepted its offer. The closing receipt drops the entry.
 */

/** The most cards kept from the ranked list at the start of a call. */
export const VOICE_START_CARDS_MAX = 50

export interface StartCard {
	/** The object the card is about; null for a card with no object. */
	objectId: string | null
	notificationId: string | null
	source: 'curated' | 'decision'
	rank: number
	/** What the card is called, for receipts. Kept in memory only. */
	title?: string | null
}

export interface PendingHoldSummary {
	tool: string
	/** What the held call would do, in a few words. Never the text of a draft. */
	summary: string
	yesCount: number
}

export interface VoiceCallState {
	/** The ranked For You list when the call began, best first. Null when it was not read (or lost). */
	startCards: StartCard[] | null
	/** The first card of startCards that the call showed, opened or changed. */
	firstCardNamed: string | null
	pendingHold: (() => PendingHoldSummary | null) | null
	/** True once the call read the caller's For You list, so the receipt may talk about cards. */
	forYouRead?: boolean
	/** Receipt rows still being written, so the closing receipt can wait for them. */
	inflight: Set<Promise<unknown>>
}

const calls = new Map<string, VoiceCallState>()

export function voiceCallState(voiceSessionId: string): VoiceCallState {
	let state = calls.get(voiceSessionId)
	if (!state) {
		state = { startCards: null, firstCardNamed: null, pendingHold: null, inflight: new Set() }
		calls.set(voiceSessionId, state)
	}
	return state
}

export function peekVoiceCallState(voiceSessionId: string): VoiceCallState | undefined {
	return calls.get(voiceSessionId)
}

export function dropVoiceCallState(voiceSessionId: string): void {
	calls.delete(voiceSessionId)
}

/** The id a card goes by in events and receipts: its object, else its notification. */
export function cardIdOf(card: StartCard): string | null {
	return card.objectId ?? card.notificationId
}

export function startCardsFrom(items: ForYouItem[]): StartCard[] {
	return items.slice(0, VOICE_START_CARDS_MAX).map((item) => ({
		objectId: item.entity_id,
		notificationId: item.notification_id,
		source: item.source,
		rank: item.rank,
		title: item.object?.title || item.headline || null,
	}))
}

/**
 * Reads the person's ranked For You list, the same one the web page shows, and keeps its top cards
 * with the call. A failure is logged and leaves the list unknown: it must not stop a call starting.
 */
export async function readStartCards(
	db: Database,
	session: { id: string; workspaceId: string; humanActorId: string },
): Promise<StartCard[] | null> {
	try {
		const cards = startCardsFrom(
			await buildForYouItems(db, session.workspaceId, session.humanActorId),
		)
		voiceCallState(session.id).startCards = cards
		return cards
	} catch (err) {
		logger.warn('Voice call could not read the For You list at start', {
			voice_session_id: session.id,
			error: err instanceof Error ? err.message : String(err),
		})
		return null
	}
}

/** The start card any of these ids belongs to, if one does. */
export function matchStartCard(
	state: Pick<VoiceCallState, 'startCards'>,
	ids: string[],
): StartCard | null {
	if (!state.startCards || ids.length === 0) return null
	const wanted = new Set(ids)
	return (
		state.startCards.find(
			(card) =>
				(card.objectId !== null && wanted.has(card.objectId)) ||
				(card.notificationId !== null && wanted.has(card.notificationId)),
		) ?? null
	)
}

/** Records the first card the call names. Later cards never replace it. */
export function noteCardNamed(state: VoiceCallState, ids: string[]): void {
	if (state.firstCardNamed) return
	const card = matchStartCard(state, ids)
	const id = card ? cardIdOf(card) : null
	if (id) state.firstCardNamed = id
}
