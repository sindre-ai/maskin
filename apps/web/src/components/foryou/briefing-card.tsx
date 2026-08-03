import { MarkdownContent } from '@/components/shared/markdown-content'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import { useFile } from '@/hooks/use-files'
import { trackFypBriefingAudioPlayed, trackFypBriefingRead } from '@/lib/analytics'
import type { LatestBriefingResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { ChevronDownIcon, PauseIcon, PlayIcon } from 'lucide-react'
import { type SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface BriefingCardProps {
	workspaceId: string
	briefing: LatestBriefingResponse & { object: NonNullable<LatestBriefingResponse['object']> }
}

// >50% scroll of the card body threshold for `fyp_briefing_read`.
const READ_THRESHOLD = 0.5
// >60s of playback threshold for `fyp_briefing_audio_played`.
const AUDIO_PLAYED_THRESHOLD_SECONDS = 60

export function BriefingCard({ workspaceId, briefing }: BriefingCardProps) {
	const { object, audioFileId, unreadDelta } = briefing
	const briefingId = object.id
	const content = object.content ?? ''

	// Audio content — fetched lazily via useFile. Falls back to a disabled play
	// button when the audio hasn't rendered yet (T2's pipeline is async).
	const { data: audioFile } = useFile(workspaceId, audioFileId)
	const audioSrc = useMemo(() => {
		if (!audioFile) return null
		if (audioFile.encoding !== 'base64') return audioFile.url ?? null
		return `data:${audioFile.mimeType};base64,${audioFile.content}`
	}, [audioFile])

	const audioRef = useRef<HTMLAudioElement>(null)
	const [isPlaying, setIsPlaying] = useState(false)
	const [audioDuration, setAudioDuration] = useState<number | null>(null)
	const [playedSeconds, setPlayedSeconds] = useState(0)
	const audioFiredRef = useRef(false)

	const handlePlayPause = useCallback(() => {
		const el = audioRef.current
		if (!el || !audioSrc) return
		if (el.paused) {
			void el.play()
		} else {
			el.pause()
		}
	}, [audioSrc])

	const handleTimeUpdate = useCallback(
		(e: SyntheticEvent<HTMLAudioElement>) => {
			const t = e.currentTarget.currentTime
			setPlayedSeconds(t)
			if (!audioFiredRef.current && t >= AUDIO_PLAYED_THRESHOLD_SECONDS) {
				audioFiredRef.current = true
				trackFypBriefingAudioPlayed({ entity_id: briefingId })
			}
		},
		[briefingId],
	)

	const handleLoadedMetadata = useCallback((e: SyntheticEvent<HTMLAudioElement>) => {
		const d = e.currentTarget.duration
		if (Number.isFinite(d) && d > 0) setAudioDuration(d)
	}, [])

	// Reset audio metrics whenever the briefing swaps (SSE invalidation on a
	// fresh CoS-authored briefing). Prevents the >60s flag carrying over.
	// biome-ignore lint/correctness/useExhaustiveDependencies: briefingId is the reset trigger, not read inside
	useEffect(() => {
		audioFiredRef.current = false
		setPlayedSeconds(0)
		setIsPlaying(false)
	}, [briefingId])

	// >50% scroll of the card body sentinel. IntersectionObserver fires when the
	// midpoint of the body enters the viewport, at which point the reader has
	// seen the first half of the prose.
	const bodyRef = useRef<HTMLDivElement>(null)
	const readFiredRef = useRef(false)
	// biome-ignore lint/correctness/useExhaustiveDependencies: briefingId is the reset trigger, not read inside
	useEffect(() => {
		readFiredRef.current = false
	}, [briefingId])
	useEffect(() => {
		const node = bodyRef.current
		if (!node) return
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (
						entry.isIntersecting &&
						entry.intersectionRatio >= READ_THRESHOLD &&
						!readFiredRef.current
					) {
						readFiredRef.current = true
						trackFypBriefingRead({ entity_id: briefingId })
						observer.disconnect()
						return
					}
				}
			},
			{ threshold: [READ_THRESHOLD] },
		)
		observer.observe(node)
		return () => observer.disconnect()
	}, [briefingId])

	const remaining = audioDuration !== null ? Math.max(0, audioDuration - playedSeconds) : null
	const durationLabel = formatDuration(remaining ?? audioDuration)

	return (
		<div
			data-testid="briefing-card"
			className={cn(
				// Reuses UnreadThreadCard's shell: hairline top-rule + mention-yellow
				// left border + shared inline card padding. Left border is bg-warning
				// (mention colour) so the featured briefing reads as unread-priority
				// without inventing a new accent.
				'group relative border-t border-b border-border bg-background pt-3 pb-2.5 pl-3 pr-3',
				'border-l-2 border-l-warning pl-[10px]',
			)}
		>
			{/* Kicker row: "Briefing" label + optional unread-since badge + timestamp. */}
			<div className="flex items-center gap-1.5">
				<span
					className="inline-flex shrink-0 items-center rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warning"
					aria-label="Featured briefing"
				>
					Briefing
				</span>
				{unreadDelta > 0 && (
					<span
						data-testid="briefing-unread-delta"
						aria-label={`${unreadDelta} updates since your last briefing`}
						className="inline-flex shrink-0 items-center rounded-full border border-border bg-secondary px-2 py-0.5 text-[10.5px] font-medium tabular-nums text-muted-foreground"
					>
						{unreadDelta} new since last briefing
					</span>
				)}
				<span className="flex-1" />
				{object.createdAt && (
					<RelativeTime
						date={object.createdAt}
						className="font-mono tabular-nums text-xs text-muted-foreground"
					/>
				)}
			</div>

			<h2 className="mt-2 text-[15px] font-semibold leading-snug text-foreground">
				{object.title ?? "Today's briefing"}
			</h2>

			{/* Audio row: filled play + duration (no spinner per D1 — audio is
			    pre-rendered by T2's TTS pipeline). Disabled with a "rendering…"
			    tooltip when the pipeline hasn't produced audio yet. */}
			<div className="mt-2 flex items-center gap-2">
				<Button
					type="button"
					size="sm"
					variant="default"
					className="h-8 w-8 rounded-full p-0"
					aria-label={isPlaying ? 'Pause briefing audio' : 'Play briefing audio'}
					disabled={!audioSrc}
					onClick={handlePlayPause}
				>
					{isPlaying ? <PauseIcon size={14} aria-hidden /> : <PlayIcon size={14} aria-hidden />}
				</Button>
				<span className="text-xs tabular-nums text-muted-foreground">
					{durationLabel ?? (audioFileId ? 'Loading…' : 'Audio rendering')}
				</span>
				{audioSrc && (
					<audio
						ref={audioRef}
						src={audioSrc}
						preload="metadata"
						onPlay={() => setIsPlaying(true)}
						onPause={() => setIsPlaying(false)}
						onEnded={() => setIsPlaying(false)}
						onLoadedMetadata={handleLoadedMetadata}
						onTimeUpdate={handleTimeUpdate}
						data-testid="briefing-audio"
					>
						<track kind="captions" />
					</audio>
				)}
			</div>

			{/* Prose body — deep-link chips embed as markdown links written by CoS,
			    they render as regular anchors and navigate by href. */}
			<div ref={bodyRef} data-testid="briefing-body" className="mt-2.5">
				{content ? (
					<MarkdownContent content={content} className="text-[13.5px]" size="sm" />
				) : (
					<p className="text-[13.5px] text-muted-foreground">Briefing content pending…</p>
				)}
			</div>

			{/* Footer chevron — "continue to feed" affordance per D1. Scrolls the
			    next feed item into view without changing routes. */}
			<div className="mt-2 flex items-center justify-end">
				<button
					type="button"
					aria-label="Continue to feed"
					className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
					onClick={() => {
						// Scroll one card-height down so the next feed section
						// (onboarding prompt or "Today") crosses into view.
						window.scrollBy({ top: 240, behavior: 'smooth' })
					}}
				>
					Continue to feed
					<ChevronDownIcon size={14} aria-hidden />
				</button>
			</div>
		</div>
	)
}

function formatDuration(seconds: number | null): string | null {
	if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null
	const total = Math.round(seconds)
	const m = Math.floor(total / 60)
	const s = total % 60
	return `${m}:${s.toString().padStart(2, '0')}`
}
