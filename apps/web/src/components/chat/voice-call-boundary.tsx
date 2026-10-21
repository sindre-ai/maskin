/**
 * Voice-call boundary divider shown at head + tail of the turns a voice call
 * contributed to a Conversation, plus the inline `voice` meta tag rendered
 * alongside the timestamp of every voice-originated message. Copy is verbatim
 * from the Voice v1 design SPEC §Copy — do not paraphrase. Uses the existing
 * `.eyebrow` micro-caps class and the hairline pattern from `MessageDivider`
 * so the two dividers never drift apart.
 */

import { cn } from '@/lib/cn'

export type VoiceCallBoundaryVariant = 'start' | 'end'

interface VoiceCallBoundaryProps {
	variant: VoiceCallBoundaryVariant
	durationMs?: number
	startedAt?: string | Date
	endedAt?: string | Date
	className?: string
}

/**
 * Formats a duration as `M:SS` (or `H:MM:SS` past the hour mark). Voice calls
 * are short — the hour path is defensive, not the common case.
 */
export function formatVoiceCallDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
	const hours = Math.floor(totalSeconds / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)
	const seconds = totalSeconds % 60
	const pad = (n: number) => n.toString().padStart(2, '0')
	if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`
	return `${minutes}:${pad(seconds)}`
}

function toDate(input: string | Date | undefined): Date | null {
	if (input == null) return null
	const d = input instanceof Date ? input : new Date(input)
	return Number.isFinite(d.getTime()) ? d : null
}

function formatClock(date: Date): string {
	return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function VoiceCallBoundary({
	variant,
	durationMs,
	startedAt,
	endedAt,
	className,
}: VoiceCallBoundaryProps) {
	const label = buildLabel(variant, { durationMs, startedAt, endedAt })
	return (
		<div
			className={cn('flex items-center gap-2.5 py-2', className)}
			data-variant={variant}
			data-testid="voice-call-boundary"
		>
			<div className="h-px flex-1 bg-border" />
			<span className={cn('eyebrow shrink-0', variant === 'end' && 'text-muted-foreground')}>
				{label}
			</span>
			<div className="h-px flex-1 bg-border" />
		</div>
	)
}

function buildLabel(
	variant: VoiceCallBoundaryVariant,
	{
		durationMs,
		startedAt,
		endedAt,
	}: { durationMs?: number; startedAt?: string | Date; endedAt?: string | Date },
): string {
	if (variant === 'end') return 'Call ended'
	const parts: string[] = ['Voice call']
	if (typeof durationMs === 'number' && durationMs >= 0) {
		parts.push(formatVoiceCallDuration(durationMs))
	}
	const start = toDate(startedAt)
	const end = toDate(endedAt)
	if (start && end) {
		parts.push(`${formatClock(start)} → ${formatClock(end)}`)
	}
	return parts.join(' · ')
}

/**
 * The inline `voice` meta tag rendered alongside a message timestamp. Small
 * enough to sit next to the 10px clock; matches the mono `.eyebrow` weight so
 * a scanner reads "voice" as a source-of-message hint, not a distinct chip.
 */
export function VoiceMessageMetaTag({ className }: { className?: string } = {}) {
	return (
		<span
			className={cn('eyebrow shrink-0', className)}
			aria-label="Sent by voice"
			data-testid="voice-message-meta-tag"
		>
			voice
		</span>
	)
}

export interface VoiceCallBoundaries {
	/** Head divider props, set on the first message of a call's run. */
	start?: { durationMs?: number; startedAt?: string; endedAt?: string }
	/** True on the last message of a call's run. */
	end?: true
}

interface VoiceBoundaryMessage {
	id: number
	createdAt: string | null
	metadata: { source?: string; voice_session_id?: string } | null
}

/**
 * Finds each voice call's run of consecutive messages (same
 * `metadata.voice_session_id`) and marks where its head and tail dividers go.
 * A text message in the middle splits a call into two runs — the divider marks
 * where the spoken part starts and stops, not the call's whole lifetime.
 * Duration and clock range come from the run's first and last message, which is
 * what the reader can see; the call's own timestamps are not on the message.
 */
export function deriveVoiceCallBoundaries(
	messages: readonly VoiceBoundaryMessage[],
): Map<number, VoiceCallBoundaries> {
	const out = new Map<number, VoiceCallBoundaries>()
	const callOf = (m: VoiceBoundaryMessage | undefined) =>
		m?.metadata?.source === 'voice' ? (m.metadata.voice_session_id ?? null) : null

	let runStart = -1
	for (let i = 0; i < messages.length; i++) {
		const call = callOf(messages[i])
		if (call === null) {
			runStart = -1
			continue
		}
		if (runStart === -1 || callOf(messages[i - 1]) !== call) runStart = i
		if (callOf(messages[i + 1]) === call) continue

		// messages[i] closes the run that began at runStart.
		const first = messages[runStart]
		const last = messages[i]
		if (!first || !last) continue
		// A message with no timestamp yields a bare "Voice call" head, which the
		// component already renders when duration and clock range are absent.
		const startedAt = first.createdAt ?? undefined
		const endedAt = last.createdAt ?? undefined
		const durationMs =
			startedAt && endedAt
				? Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime())
				: undefined
		out.set(first.id, { ...out.get(first.id), start: { durationMs, startedAt, endedAt } })
		out.set(last.id, { ...out.get(last.id), end: true })
	}
	return out
}
