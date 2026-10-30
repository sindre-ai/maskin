/**
 * Reads the two kinds of message the server posts into a thread while a live
 * call runs: one `receipt` per real change, and a closing `receipt_summary`.
 * Both ride on `metadata` with `source: 'voice'`. Anything that does not match
 * the contract parses to null so the message renders as a plain message.
 */

export type VoiceReceiptEvent =
	| 'created_bet'
	| 'created_task'
	| 'opened_task'
	| 'moved_to_review'
	| 'decided'
	| 'other'

export type VoiceReceiptOutcome = 'ran' | 'failed' | 'not_done'

export interface VoiceReceiptRow {
	kind: 'receipt'
	voiceSessionId: string | null
	event: VoiceReceiptEvent
	objectId: string | null
	text: string
	/** Seconds into the call. */
	t: number
	outcome: VoiceReceiptOutcome
}

export interface VoiceSummaryCreated {
	type: string
	title: string
	objectId: string | null
}

export interface VoiceReceiptSummary {
	kind: 'receipt_summary'
	voiceSessionId: string | null
	durationSeconds: number
	decided: string[]
	created: VoiceSummaryCreated[]
	next: string[]
	notDone: string[]
}

export type VoiceReceipt = VoiceReceiptRow | VoiceReceiptSummary

const EVENTS: readonly VoiceReceiptEvent[] = [
	'created_bet',
	'created_task',
	'opened_task',
	'moved_to_review',
	'decided',
	'other',
]

const OUTCOMES: readonly VoiceReceiptOutcome[] = ['ran', 'failed', 'not_done']

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
	return typeof v === 'string' && v.trim() !== '' ? v : null
}

function strings(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

function seconds(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

export function parseVoiceReceipt(metadata: unknown): VoiceReceipt | null {
	if (!isRecord(metadata) || metadata.source !== 'voice') return null
	const voiceSessionId = str(metadata.voice_session_id)

	if (metadata.kind === 'receipt') {
		const text = str(metadata.text)
		if (!text) return null
		const event = EVENTS.find((e) => e === metadata.event) ?? 'other'
		const outcome = OUTCOMES.find((o) => o === metadata.outcome) ?? 'ran'
		return {
			kind: 'receipt',
			voiceSessionId,
			event,
			objectId: str(metadata.object_id),
			text,
			t: seconds(metadata.t),
			outcome,
		}
	}

	if (metadata.kind === 'receipt_summary') {
		const created = Array.isArray(metadata.created)
			? metadata.created.flatMap((c): VoiceSummaryCreated[] => {
					if (!isRecord(c)) return []
					const title = str(c.title)
					if (!title) return []
					return [{ type: str(c.type) ?? 'task', title, objectId: str(c.object_id) }]
				})
			: []
		return {
			kind: 'receipt_summary',
			voiceSessionId,
			durationSeconds: seconds(metadata.duration_seconds),
			decided: strings(metadata.decided),
			created,
			next: strings(metadata.next),
			notDone: strings(metadata.not_done),
		}
	}

	return null
}

/** Mono label shown on an event row. */
export function voiceReceiptLabel(event: VoiceReceiptEvent): string {
	switch (event) {
		case 'created_bet':
			return 'Created bet'
		case 'created_task':
			return 'Created task'
		case 'opened_task':
			return 'Opened task'
		case 'moved_to_review':
			return 'Moved to review'
		case 'decided':
			return 'Decided'
		case 'other':
			return 'Changed'
	}
}

/** Call-relative timestamp: m:ss under an hour, h:mm:ss from 1:00:00. */
export function formatCallClock(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds))
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	const sec = s % 60
	const pad = (n: number) => n.toString().padStart(2, '0')
	return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}
