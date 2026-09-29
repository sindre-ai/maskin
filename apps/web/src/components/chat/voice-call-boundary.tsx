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
