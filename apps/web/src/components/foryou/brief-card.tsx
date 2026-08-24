import { MarkdownContent } from '@/components/shared/markdown-content'
import { QueryStateError } from '@/components/shared/query-state'
import { StatusBadge } from '@/components/shared/status-badge'
import { type BriefPlayback, formatClock, useBriefPlayback } from '@/hooks/use-brief-playback'
import { useBriefing } from '@/hooks/use-briefing'
import { useObjects } from '@/hooks/use-objects'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { ChevronDown, ChevronUp, Pause, Play } from 'lucide-react'
import { useMemo, useState } from 'react'

// Splits the briefing markdown into its leading H1 (rendered as the card's
// headline) and the rest of the document. The backend composes the briefing
// with a `# {workspace} — workspace briefing` heading; when it doesn't, the
// whole document falls through to the body.
export function splitBriefHeadline(markdown: string): { headline: string | null; body: string } {
	const match = markdown.match(/^\s*#\s+(.+?)\s*(?:\n|$)/)
	if (!match) return { headline: null, body: markdown }
	return { headline: match[1] ?? null, body: markdown.slice(match[0].length) }
}

/**
 * The prose, without the machine plumbing. `renderWorkspaceBriefing` prints an
 * ``id: `<uuid>` `` line under every object it lists so the ids can be resolved
 * (see `briefMentionedIds`); those lines are addressing, not writing, and the
 * mockup's transcript is clean paragraphs.
 */
export function briefTranscript(markdown: string): string {
	return markdown
		.split('\n')
		.filter((line) => !/^\s*id:\s*`/.test(line))
		.join('\n')
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/**
 * Object ids the brief names. `renderWorkspaceBriefing` prints an
 * ``id: `<uuid>` `` line under every bet it lists and links objects as
 * markdown hrefs, so the ids are really in the document — the MENTIONED row
 * resolves them against the workspace object list rather than inventing
 * references.
 */
export function briefMentionedIds(markdown: string): string[] {
	const seen = new Set<string>()
	for (const match of markdown.matchAll(UUID_RE)) {
		seen.add(match[0].toLowerCase())
	}
	return [...seen]
}

/**
 * Flattens the brief markdown into something worth speaking: drops heading
 * hashes, list bullets, emphasis/backtick syntax, the raw `id:` lines and
 * link targets (keeping the link text).
 */
export function briefSpokenText(markdown: string): string {
	return markdown
		.split('\n')
		.filter((line) => !/^\s*id:\s*`/.test(line))
		.join('\n')
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/[#>*_`]/g, '')
		.replace(/^\s*-\s+/gm, '')
		.replace(/\s+/g, ' ')
		.trim()
}

// The chip's leading swatch is the object type's own colour, drawn as the
// mockup's 7px square. Written out as literals so Tailwind's class scanner
// sees them.
const TYPE_SWATCH: Record<string, string> = {
	insight: 'bg-type-insight-text',
	bet: 'bg-type-bet-text',
	task: 'bg-type-task-text',
}
const DEFAULT_TYPE_SWATCH = 'bg-muted-foreground'

// The mockup's 40-bar meter, heights and all (`this.WAVE`). It is a fixed
// decorative pattern — SpeechSynthesis exposes no amplitude, so this is a
// progress meter drawn in the mockup's bar idiom, never the audio itself.
const WAVE_BARS = Array.from(
	{ length: 40 },
	(_, i) => 4 + Math.round(Math.abs(Math.sin(i * 1.25) + Math.cos(i * 0.6)) * 9) + (i % 3) * 2,
)

function BriefPlayer({ playback }: { playback: BriefPlayback }) {
	const filled = Math.round(playback.progress * WAVE_BARS.length)
	return (
		<div
			data-testid="brief-player"
			className="mt-3.5 flex items-center gap-3.5 rounded-xl border border-border bg-muted/40 px-3.5 py-3"
		>
			<button
				type="button"
				className="grid size-[38px] shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
				onClick={playback.toggle}
				aria-pressed={playback.playing}
				aria-label={playback.playing ? 'Stop reading the brief' : 'Read the brief aloud'}
			>
				{playback.playing ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
			</button>
			<div className="min-w-0 flex-1">
				<div aria-hidden className="flex h-6 items-end gap-[2px]">
					{WAVE_BARS.map((height, index) => (
						<span
							key={`${height}-${index === 0 ? 'a' : index}`}
							className={cn(
								'w-[3px] shrink-0 rounded-sm',
								index < filled ? 'bg-foreground' : 'bg-border',
							)}
							style={{ height: `${height}px` }}
						/>
					))}
				</div>
				<div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-muted-foreground">
					<span className="font-semibold text-foreground tabular-nums">
						{formatClock(playback.elapsedMs)}
					</span>
					<span className="tabular-nums">/ {formatClock(playback.estimatedTotalMs)}</span>
					<span className="ml-auto">1×</span>
				</div>
			</div>
		</div>
	)
}

/**
 * Today's brief — the first card in the For You feed (Feed v4, lines 107–139).
 *
 * Collapsed it is the feed's one inverted block: a play tile that starts the
 * read-aloud without opening anything, the title, and a meta line. Opening it
 * reveals the headline, the player, and the objects the brief names — the
 * prose stays folded behind "Prefer to read? Show the transcript", since the
 * brief is meant to be listened to.
 *
 * Playback runs through the browser's SpeechSynthesis (see `useBriefPlayback`)
 * — `GET /briefing` returns markdown only, so there is no audio asset and no
 * server TTS; where the browser has no SpeechSynthesis there is no player and
 * the transcript is simply the body. `/$workspaceId/briefing` stays as the
 * deep-linkable full page.
 */
export function BriefCard({ workspaceId }: { workspaceId: string }) {
	const [open, setOpen] = useState(false)
	const { data, isLoading, isError, error, refetch } = useBriefing(workspaceId)

	const markdown = data?.markdown ?? ''
	const { headline, body } = splitBriefHeadline(markdown)
	const playback = useBriefPlayback(useMemo(() => briefSpokenText(markdown), [markdown]))
	// The brief leads with the player and keeps the prose folded away (the
	// mockup's `briefMode: "listen"` default). With no SpeechSynthesis there is
	// nothing to listen to, so the transcript is all there is.
	const [transcriptOpen, setTranscriptOpen] = useState(false)
	const showTranscript = !playback.supported || transcriptOpen

	const { data: objects } = useObjects(workspaceId)
	const mentioned = useMemo(() => {
		if (!markdown || !objects) return []
		const ids = new Set(briefMentionedIds(markdown))
		return objects.filter((object) => ids.has(object.id.toLowerCase()))
	}, [markdown, objects])

	// The mockup's meta line reads "Thursday · 08:30 · 2:14 · by Relay" at rest
	// and counts up while it plays. `GET /briefing` returns markdown only — no
	// cut time and no narrator — so ours is the weekday plus how long it runs.
	const weekday = new Date().toLocaleDateString(undefined, { weekday: 'long' })
	const duration = formatClock(playback.estimatedTotalMs)
	const meta = !playback.supported
		? weekday
		: playback.playing
			? `${formatClock(playback.elapsedMs)} / ${duration}`
			: `${weekday} · ${duration}`

	return (
		<div
			data-testid="brief-card"
			className="mb-1 mt-3 flex flex-col overflow-hidden rounded-xl bg-brief-surface text-brief-foreground"
		>
			<div className="flex items-center gap-3 px-3.5 py-2.5 transition-colors duration-150 hover:bg-brief-surface-hover">
				{playback.supported && (
					<button
						type="button"
						className="grid size-[34px] shrink-0 place-items-center rounded-lg bg-brief-foreground/15 text-brief-foreground transition-colors duration-150 hover:bg-brief-foreground/25"
						onClick={playback.toggle}
						aria-pressed={playback.playing}
						aria-label={playback.playing ? 'Stop reading the brief' : 'Read the brief aloud'}
					>
						{playback.playing ? <Pause size={12} aria-hidden /> : <Play size={12} aria-hidden />}
					</button>
				)}
				<button
					type="button"
					onClick={() => setOpen((prev) => !prev)}
					aria-expanded={open}
					aria-label="Today's brief"
					className="flex min-w-0 flex-1 items-center gap-3 text-left"
				>
					<span className="min-w-0 flex-1 leading-[1.35]">
						<span className="block text-[13px] font-bold tracking-[-0.01em]">Today's brief</span>
						<span className="block text-[11.5px] text-brief-foreground/60">{meta}</span>
					</span>
					<span aria-hidden className="shrink-0 text-brief-foreground/45">
						{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
					</span>
				</button>
			</div>

			{open && (
				<div className="border-t border-border bg-background px-[18px] py-4 text-foreground">
					{isLoading ? (
						<p className="py-2 text-sm text-muted-foreground">Loading the brief…</p>
					) : isError ? (
						<QueryStateError
							title="Couldn't load briefing"
							error={error instanceof Error ? error : new Error('Unknown error')}
							onRetry={() => refetch()}
						/>
					) : (
						<>
							{headline && (
								<div className="text-base font-bold leading-[1.35] tracking-[-0.015em] text-pretty">
									{headline}
								</div>
							)}

							{playback.supported && (
								<>
									<BriefPlayer playback={playback} />
									<button
										type="button"
										onClick={() => setTranscriptOpen((prev) => !prev)}
										className="mt-3 inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-brand hover:text-brand-hover"
									>
										{transcriptOpen ? 'Hide the transcript' : 'Prefer to read? Show the transcript'}
									</button>
								</>
							)}

							{showTranscript && (
								<div className="mt-3.5">
									<MarkdownContent content={briefTranscript(body)} />
								</div>
							)}

							{mentioned.length > 0 && (
								<>
									<div className="mb-2.5 mt-5 flex items-center gap-2.5">
										<span className="eyebrow">Mentioned</span>
										<div className="h-px flex-1 bg-muted" />
									</div>
									<ul className="flex flex-wrap gap-[7px]">
										{mentioned.map((object) => (
											<li key={object.id}>
												<Link
													to="/$workspaceId/objects/$objectId"
													params={{ workspaceId, objectId: object.id }}
													className="inline-flex items-center gap-[7px] rounded-[9px] border border-border bg-card px-[11px] py-1.5 text-[11.5px] hover:border-border-strong hover:bg-muted/40"
												>
													<span
														aria-hidden
														className={cn(
															'size-[7px] shrink-0 rounded-[2px]',
															TYPE_SWATCH[object.type] ?? DEFAULT_TYPE_SWATCH,
														)}
													/>
													<span className="max-w-[12rem] truncate font-semibold text-foreground">
														{object.title || 'Untitled'}
													</span>
													<span className="border-l border-muted pl-2">
														<StatusBadge
															status={object.status}
															variant="word"
															className="text-[11px] font-semibold"
														/>
													</span>
												</Link>
											</li>
										))}
									</ul>
								</>
							)}
						</>
					)}
				</div>
			)}
		</div>
	)
}
