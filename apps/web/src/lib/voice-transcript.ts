/**
 * The spoken lines of a call. They are saved in the thread as messages tagged
 * `source: 'voice'` (receipts and the open-questions list read them), but the
 * thread does not draw them: the Transcript view does, from this model.
 */

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

/**
 * A saved spoken line: source 'voice' and no `kind` at all. Anything with a kind
 * (receipt, receipt_summary, show) is something else the call put in the thread
 * and draws as usual.
 */
export function isSpokenVoiceLine(m: Pick<VoiceTranscriptMessage, 'metadata'>): boolean {
	return m.metadata?.source === 'voice' && m.metadata.kind == null
}

/**
 * The calls whose thread holds a receipt or a summary. Only those calls have
 * something drawn in place of their spoken lines; for any other call the lines
 * are the only record the person can see, so they stay.
 */
export function sessionsWithReceipts(
	messages: readonly Pick<VoiceTranscriptMessage, 'metadata'>[],
): Set<string> {
	const out = new Set<string>()
	for (const m of messages) {
		const md = m.metadata
		if (md?.source !== 'voice' || !md.voice_session_id) continue
		if (md.kind === 'receipt' || md.kind === 'receipt_summary') out.add(md.voice_session_id)
	}
	return out
}

/** A spoken line to fold away: its call has receipts that stand in for it. */
export function isFoldedSpokenLine(
	m: Pick<VoiceTranscriptMessage, 'metadata'>,
	withReceipts: ReadonlySet<string>,
): boolean {
	const id = m.metadata?.voice_session_id
	return isSpokenVoiceLine(m) && !!id && withReceipts.has(id)
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
