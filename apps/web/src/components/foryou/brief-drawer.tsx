import { Composer } from '@/components/chat/chat'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { QueryStateError } from '@/components/shared/query-state'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useDefaultChatAgent } from '@/hooks/use-actors'
import { useBriefing } from '@/hooks/use-briefing'
import { useCreateConversation } from '@/hooks/use-conversations'
import { useObjects } from '@/hooks/use-objects'
import {
	EMPTY_CHAT_SELECTION,
	buildOneShotActionPrompt,
	chatSelectionReducer,
} from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { Link, useNavigate } from '@tanstack/react-router'
import { Pause, Play } from 'lucide-react'
import { useCallback, useMemo, useReducer, useState } from 'react'
import { type BriefPlayback, formatClock, useBriefPlayback } from './brief-playback'

interface BriefDrawerProps {
	workspaceId: string
	open: boolean
	onOpenChange: (open: boolean) => void
}

// Splits the briefing markdown into its leading H1 (rendered as the drawer's
// headline) and the rest of the document. The backend composes the briefing
// with a `# {workspace} — workspace briefing` heading; when it doesn't, the
// whole document falls through to the body.
export function splitBriefHeadline(markdown: string): { headline: string | null; body: string } {
	const match = markdown.match(/^\s*#\s+(.+?)\s*(?:\n|$)/)
	if (!match) return { headline: null, body: markdown }
	return { headline: match[1] ?? null, body: markdown.slice(match[0].length) }
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

// 34 bars, matching the mockup's meter. The heights are a fixed decorative
// pattern — SpeechSynthesis exposes no amplitude, so this is a progress meter
// drawn in the mockup's bar idiom, never a rendering of the audio itself.
const WAVE_BARS = Array.from({ length: 34 }, (_, i) => 7 + ((i * 7) % 17))

function BriefPlayer({ playback }: { playback: BriefPlayback }) {
	const filled = Math.round(playback.progress * WAVE_BARS.length)
	return (
		<div
			data-testid="brief-player"
			className="mt-4 flex items-center gap-3.5 rounded-2xl border border-border bg-muted/40 px-4 py-3.5"
		>
			<Button
				type="button"
				size="icon"
				className="size-[42px] shrink-0 rounded-full"
				onClick={playback.toggle}
				aria-pressed={playback.playing}
				aria-label={playback.playing ? 'Stop reading the brief' : 'Read the brief aloud'}
			>
				{playback.playing ? <Pause size={15} aria-hidden /> : <Play size={15} aria-hidden />}
			</Button>
			<div className="min-w-0 flex-1">
				<div aria-hidden className="flex h-[26px] items-end gap-[2px]">
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
					<span className="tabular-nums">/ ~{formatClock(playback.estimatedTotalMs)}</span>
					<span className="ml-auto">1×</span>
				</div>
			</div>
		</div>
	)
}

/**
 * The v2 Brief (mockup 3414–3463): a right-side drawer opened from the top
 * nav's Brief action, over whatever screen you're on. Playback runs through
 * the browser's SpeechSynthesis (see `useBriefPlayback`) — `GET /briefing`
 * returns markdown only, so there is no audio asset and no server TTS; where
 * the browser has no SpeechSynthesis the player and the "Listen instead"
 * toggle are not rendered at all. `/$workspaceId/briefing` stays as the
 * deep-linkable full page.
 */
export function BriefDrawer({ workspaceId, open, onOpenChange }: BriefDrawerProps) {
	const { data, isLoading, isError, error, refetch } = useBriefing(workspaceId)
	const defaultChatAgent = useDefaultChatAgent()
	const createConversation = useCreateConversation(workspaceId)
	const navigate = useNavigate()
	const [selection, dispatchSelection] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	const [sendError, setSendError] = useState<string | null>(null)

	const agent = selection.agent ?? defaultChatAgent
	const markdown = data?.markdown ?? ''
	const { headline, body } = splitBriefHeadline(markdown)

	const playback = useBriefPlayback(useMemo(() => briefSpokenText(markdown), [markdown]))
	// "Listen instead" hides the prose the way the mockup does; without
	// SpeechSynthesis there is nothing to switch to, so read mode is forced.
	const [listenMode, setListenMode] = useState(false)
	const readMode = !playback.supported || !listenMode

	const { data: objects } = useObjects(workspaceId)
	const mentioned = useMemo(() => {
		if (!markdown || !objects) return []
		const ids = new Set(briefMentionedIds(markdown))
		return objects.filter((object) => ids.has(object.id.toLowerCase()))
	}, [markdown, objects])

	// Reuses the same create-conversation path the sparse composer uses, so a
	// follow-up on the brief lands in the normal chats surface.
	const onSend = useCallback(
		async (content: string) => {
			setSendError(null)
			if (!agent) {
				const err = new Error('No agent available to start a chat')
				setSendError(err.message)
				throw err
			}
			const hasContext =
				selection.objects.length > 0 ||
				selection.notifications.length > 0 ||
				selection.files.length > 0
			const initialMessage = hasContext
				? buildOneShotActionPrompt(
						content,
						selection.objects,
						selection.notifications,
						selection.files,
					)
				: content
			const conversation = await createConversation.mutateAsync({
				title: agent.name ?? 'New chat',
				participant_actor_ids: [agent.id],
				initial_message: initialMessage,
			})
			dispatchSelection({ type: 'clear_all' })
			onOpenChange(false)
			navigate({
				to: '/$workspaceId/chats/$conversationId',
				params: { workspaceId, conversationId: conversation.id },
			})
		},
		[agent, selection, createConversation, navigate, workspaceId, onOpenChange],
	)

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
				data-testid="brief-drawer"
			>
				<div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4 pr-14">
					<div className="min-w-0">
						<SheetTitle className="text-[13.5px] font-bold">Your brief</SheetTitle>
						<p className="text-[11px] text-muted-foreground">
							The workspace snapshot that opens every agent session
						</p>
					</div>
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
					{isLoading ? (
						<CardSkeleton />
					) : isError ? (
						<QueryStateError
							title="Couldn't load briefing"
							error={error instanceof Error ? error : new Error('Unknown error')}
							onRetry={() => refetch()}
						/>
					) : (
						<>
							{headline && (
								<h2 className="text-base font-bold leading-snug tracking-tight text-foreground">
									{headline}
								</h2>
							)}

							{playback.supported && (
								<>
									<BriefPlayer playback={playback} />
									<button
										type="button"
										onClick={() => setListenMode((prev) => !prev)}
										className="mt-3 inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-brand hover:text-brand-hover"
									>
										{readMode ? 'Listen instead' : 'Read instead'}
									</button>
								</>
							)}

							{readMode && (
								<div className="mt-3.5">
									<MarkdownContent content={body} />
								</div>
							)}

							{mentioned.length > 0 && (
								<>
									<div className="mb-2.5 mt-5 flex items-center gap-2.5">
										<span className="eyebrow">Mentioned</span>
										<div className="h-px flex-1 bg-border" />
									</div>
									<ul className="flex flex-wrap gap-1.5">
										{mentioned.map((object) => (
											<li key={object.id}>
												<Link
													to="/$workspaceId/objects/$objectId"
													params={{ workspaceId, objectId: object.id }}
													onClick={() => onOpenChange(false)}
													className="inline-flex items-center gap-2 rounded-[9px] border border-border bg-card px-2.5 py-1.5 text-[11.5px] hover:border-border-strong hover:bg-muted/40"
												>
													<TypeBadge type={object.type} variant="mono" />
													<span className="max-w-[12rem] truncate font-semibold text-foreground">
														{object.title || 'Untitled'}
													</span>
													<span className="border-l border-border pl-2">
														<StatusBadge status={object.status} variant="dot-word" />
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

				<div className="shrink-0 border-t border-border px-5 py-3">
					<Composer
						workspaceId={workspaceId}
						onSend={onSend}
						disabled={false}
						pending={false}
						surface="pulse-bar"
						placeholder={`Ask ${agent?.name ?? 'an agent'} to turn any of this into a task…`}
						textareaLabel="Ask about this brief"
						selection={selection}
						onDispatchSelection={dispatchSelection}
						onRemoveAgent={() => dispatchSelection({ type: 'remove_agent' })}
						onRemoveObject={(id) => dispatchSelection({ type: 'remove_object', id })}
						onRemoveNotification={(id) => dispatchSelection({ type: 'remove_notification', id })}
						onRemoveFile={(fileId) => dispatchSelection({ type: 'remove_file', fileId })}
						externalError={sendError}
						onDismissExternalError={() => setSendError(null)}
					/>
				</div>
			</SheetContent>
		</Sheet>
	)
}
