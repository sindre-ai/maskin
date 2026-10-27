/**
 * The spoken lines of a call. They are saved in the thread as messages tagged
 * `source: 'voice'` (receipts and the open-questions list read them), but the
 * thread does not draw them: the Transcript view does, from this model.
 */

import { parseVoiceReceipt } from '@/lib/voice-receipts'

export interface VoiceTranscriptMessage {
	id: number
	content: string
	createdAt: string | null
	actorName: string
	actorType: string
	metadata: { source?: string; voice_session_id?: string; kind?: string } | null
}

export interface VoiceTranscriptEntry {
	id: number
	/** Seconds since the call's first message. */
	t: number
	speaker: string
	text: string
}

/** A saved spoken line, as opposed to a receipt, a summary or an ordinary message. */
export function isSpokenVoiceLine(m: Pick<VoiceTranscriptMessage, 'metadata'>): boolean {
	return m.metadata?.source === 'voice' && parseVoiceReceipt(m.metadata) === null
}

function ms(createdAt: string | null): number | null {
	if (!createdAt) return null
	const n = new Date(createdAt).getTime()
	return Number.isFinite(n) ? n : null
}

export function buildVoiceTranscript(
	messages: readonly VoiceTranscriptMessage[],
	voiceSessionId: string,
): VoiceTranscriptEntry[] {
	const ofCall = messages
		.filter((m) => m.metadata?.source === 'voice' && m.metadata.voice_session_id === voiceSessionId)
		.sort((a, b) => a.id - b.id)
	const start = ofCall.map((m) => ms(m.createdAt)).find((t): t is number => t !== null) ?? null
	return ofCall
		.filter((m) => isSpokenVoiceLine(m) && m.content.trim() !== '')
		.map((m) => {
			const at = ms(m.createdAt)
			return {
				id: m.id,
				t: start !== null && at !== null ? Math.max(0, Math.round((at - start) / 1000)) : 0,
				speaker: m.actorType === 'human' ? 'You' : m.actorName,
				text: m.content.trim(),
			}
		})
}
