import type { Ask } from '@/components/chat/ask-block'
import { ChatTranscript } from '@/components/chat/chat-transcript'
import { ConversationHeader } from '@/components/chat/conversation-header'
import type { Participant } from '@/components/chat/in-this-chat-panel'
import { ResumeBand, type ResumeItem } from '@/components/chat/resume-band'
import { StreamingSessionChip } from '@/components/chat/streaming-session-chip'
import { coerceOptions } from '@/components/pulse/notification-input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useActors } from '@/hooks/use-actors'
import { useLiveSession } from '@/hooks/use-live-session'
import { useLoop } from '@/hooks/use-loops'
import { useNotifications } from '@/hooks/use-notifications'
import { deriveEntryAgentRole } from '@/lib/analytics'
import type { ActorListItem, SessionResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import type { ChatEvent } from '@/lib/chat-stream'
import { cn } from '@/lib/cn'
import { Send } from 'lucide-react'
import {
	type ChangeEvent,
	type FormEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'

interface ConversationViewProps {
	workspaceId: string
	session: SessionResponse
	/** All workspace actors, used by the add-someone search. Passed by the route. */
	actors: ActorListItem[]
	className?: string
}

const STREAM_ACTIVE_STATUSES = new Set(['running', 'starting', 'pending'])

/**
 * Chats conversation view. Composes the T3 shell (header / IN THIS CHAT /
 * loop chip / resume band) with the live transcript (T7): replays the
 * session's stdout logs, tails its SSE stream, surfaces the T4 streaming chip
 * while a turn is in flight, and posts new turns via the composer.
 */
export function ConversationView({
	workspaceId,
	session,
	actors,
	className,
}: ConversationViewProps) {
	const { data: liveActors } = useActors(workspaceId, { enabled: true })
	const availableActors = liveActors ?? actors
	const actorById = useMemo(() => new Map(availableActors.map((a) => [a.id, a])), [availableActors])

	const sessionAgent = session.actorId ? actorById.get(session.actorId) : undefined
	const sessionAgentRole =
		sessionAgent?.type === 'agent' ? deriveEntryAgentRole(sessionAgent.name ?? null) : null

	const config = session.config as Record<string, unknown> | null
	const configRole =
		typeof config?.entry_agent_role === 'string' ? (config.entry_agent_role as string) : null
	const isChiefOfStaff = configRole === 'chief-of-staff' || sessionAgentRole === 'chief-of-staff'

	const loopId = typeof config?.loop_id === 'string' ? (config.loop_id as string) : null
	const { data: loop } = useLoop(loopId ?? '', workspaceId)
	const loopContext = loopId && loop ? { id: loopId, name: loop.name } : null

	const chiefOfStaff = useMemo(() => {
		if (!isChiefOfStaff) return null
		const resolved =
			sessionAgent ?? availableActors.find((a) => a.type === 'agent' && a.name === 'Chief of Staff')
		return resolved
			? {
					id: resolved.id,
					name: resolved.name,
					roleLine: "Your workspace's default agent · routes you to the right specialist",
				}
			: null
	}, [availableActors, isChiefOfStaff, sessionAgent])

	// getStoredActor() parses localStorage on every call, so it returns a fresh
	// object each render. Reading it once keeps `initialParticipants` stable —
	// otherwise the `setParticipants` effect below sees a new array on every
	// render and thrashes into a Maximum-update-depth crash the moment anything
	// else in the tree re-renders.
	const owner = useMemo(() => getStoredActor(), [])

	const initialParticipants = useMemo<Participant[]>(() => {
		const rows: Participant[] = []
		if (chiefOfStaff) {
			rows.push({
				id: chiefOfStaff.id,
				name: chiefOfStaff.name,
				type: 'agent',
				role: 'chief-of-staff',
				roleLine: 'Routes your ask to the right specialist',
				locked: true,
			})
		}
		if (owner) {
			rows.push({
				id: owner.id,
				name: owner.name,
				type: owner.type === 'human' ? 'human' : 'agent',
				isSelf: true,
			})
		}
		if (sessionAgent && sessionAgent.id !== chiefOfStaff?.id) {
			rows.push({
				id: sessionAgent.id,
				name: sessionAgent.name,
				type: 'agent',
				pulledInLine: chiefOfStaff ? `Pulled in by ${chiefOfStaff.name}` : 'Working on this thread',
			})
		}
		return rows
	}, [chiefOfStaff, owner, sessionAgent])

	const [participants, setParticipants] = useState<Participant[]>(initialParticipants)

	useEffect(() => {
		setParticipants(initialParticipants)
	}, [initialParticipants])

	const handleAddParticipant = (actor: ActorListItem) => {
		setParticipants((prev) => {
			if (prev.some((p) => p.id === actor.id)) return prev
			return [
				...prev,
				{
					id: actor.id,
					name: actor.name,
					type: actor.type === 'human' ? 'human' : 'agent',
					pulledInLine: chiefOfStaff ? `Pulled in by ${chiefOfStaff.name}` : null,
				},
			]
		})
	}

	const handleRemoveParticipant = (id: string) => {
		setParticipants((prev) => prev.filter((p) => p.id !== id || p.locked))
	}

	const conversationUrl =
		typeof window !== 'undefined'
			? `${window.location.origin}/${workspaceId}/chats/${session.id}`
			: `/${workspaceId}/chats/${session.id}`

	const title = session.actionPrompt?.trim() || 'Untitled conversation'
	const lastActivityAt =
		session.updatedAt ?? session.completedAt ?? session.startedAt ?? session.createdAt

	const resumeItems = useMemo<ResumeItem[]>(() => {
		const items: ResumeItem[] = []
		if (session.actionPrompt)
			items.push({ text: `You said: ${trimForResume(session.actionPrompt)}` })
		if (session.currentActivity) items.push({ text: session.currentActivity })
		items.push({ text: stateAsResumeLine(session.status, chiefOfStaff?.name) })
		return items
	}, [session.actionPrompt, session.currentActivity, session.status, chiefOfStaff])

	const live = useLiveSession({ sessionId: session.id, workspaceId })

	// needs_input notifications bound to this session render as tappable
	// asks inline in the transcript, matching the chat panel behavior.
	const { data: sessionNotifications } = useNotifications(workspaceId, { type: 'needs_input' })
	const asks = useMemo<Ask[]>(() => {
		if (!sessionNotifications) return []
		return sessionNotifications
			.filter((n) => n.sessionId === session.id)
			.map((n) => ({
				id: n.id,
				title: n.title,
				content: n.content,
				question: typeof n.metadata?.question === 'string' ? n.metadata.question : null,
				options: coerceOptions(n.metadata?.options) ?? [],
				suggestion: typeof n.metadata?.suggestion === 'string' ? n.metadata.suggestion : null,
				status: n.status,
				response: n.metadata?.response,
			}))
	}, [session.id, sessionNotifications])

	// A turn is "in flight" when we just posted an input OR the session is
	// actively producing output. The chip renders in both cases so the user
	// sees Stop even after send() resolves but before the first token lands.
	const [pendingTurn, setPendingTurn] = useState(false)
	const pendingBaselineRef = useRef(0)

	useEffect(() => {
		if (!pendingTurn) return
		for (let i = pendingBaselineRef.current; i < live.events.length; i++) {
			if (isTurnProgressEvent(live.events[i])) {
				setPendingTurn(false)
				return
			}
		}
	}, [pendingTurn, live.events])

	const isSessionActive = STREAM_ACTIVE_STATUSES.has(session.status)
	const showStreamingChip = pendingTurn || isSessionActive

	const handleStopped = useCallback(() => setPendingTurn(false), [])

	const handleSend = useCallback(
		async (content: string) => {
			pendingBaselineRef.current = live.events.length
			setPendingTurn(true)
			try {
				await live.send(content)
			} catch (err) {
				setPendingTurn(false)
				throw err
			}
		},
		[live],
	)

	// Composer stays enabled on terminal sessions so the resume-band's
	// "reply to reopen" promise isn't a lie — a stopped/failed session that
	// receives a POST will surface the backend's error inline (reopen wiring
	// belongs to a follow-up bet).
	const composerDisabled = live.status === 'loading'
	const showEmpty = live.events.length === 0

	return (
		<div className={cn('flex min-h-0 flex-col bg-background', className)}>
			<ConversationHeader
				workspaceId={workspaceId}
				title={title}
				participants={participants}
				availableActors={availableActors}
				onAddParticipant={handleAddParticipant}
				onRemoveParticipant={handleRemoveParticipant}
				conversationUrl={conversationUrl}
				chiefOfStaff={chiefOfStaff}
				loop={loopContext}
			/>
			<div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 md:px-6">
				<div className="mx-auto flex h-full max-w-3xl flex-col gap-4">
					<ResumeBand items={resumeItems} lastActivityAt={lastActivityAt} />
					{showEmpty && live.status === 'loading' ? (
						<output
							className="flex items-center justify-center gap-2 py-8 text-text-muted text-sm"
							aria-live="polite"
						>
							<Spinner />
							<span>Loading conversation…</span>
						</output>
					) : (
						<ChatTranscript
							workspaceId={workspaceId}
							events={live.events}
							asks={asks}
							starting={live.status === 'loading'}
							error={live.error}
							authorLabel={chiefOfStaff ? 'DEFAULT' : null}
							className="min-h-0 flex-1"
						/>
					)}
				</div>
			</div>
			<div className="border-t border-border bg-background px-4 py-3 md:px-6">
				<div className="mx-auto flex max-w-3xl flex-col gap-2">
					{showStreamingChip ? (
						<StreamingSessionChip
							sessionId={session.id}
							workspaceId={workspaceId}
							onStopped={handleStopped}
						/>
					) : null}
					<p className="text-[11px] text-muted-foreground">
						{chiefOfStaff ? (
							<>
								Replying to{' '}
								<span className="font-semibold text-[color:var(--color-cos)]">
									{chiefOfStaff.name}
								</span>{' '}
								· she&apos;ll route it if a specialist is needed
							</>
						) : (
							'Replying to this conversation'
						)}
					</p>
					<Composer
						onSend={handleSend}
						disabled={composerDisabled}
						pending={pendingTurn || live.sending}
					/>
				</div>
			</div>
		</div>
	)
}

interface ComposerProps {
	onSend: (content: string) => Promise<void>
	disabled: boolean
	pending: boolean
}

function Composer({ onSend, disabled, pending }: ComposerProps) {
	const [value, setValue] = useState('')
	const [sendError, setSendError] = useState<string | null>(null)
	const canSend = value.trim().length > 0 && !disabled && !pending

	const handleSubmit = useCallback(
		async (e?: FormEvent<HTMLFormElement>) => {
			e?.preventDefault()
			if (!canSend) return
			const content = value.trim()
			setSendError(null)
			let sent = false
			try {
				await onSend(content)
				sent = true
			} catch (err) {
				setSendError(err instanceof Error ? err.message : 'Failed to send')
			}
			if (sent) setValue('')
		},
		[canSend, onSend, value],
	)

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key !== 'Enter') return
			if (e.shiftKey) return
			if (e.nativeEvent.isComposing) return
			e.preventDefault()
			void handleSubmit()
		},
		[handleSubmit],
	)

	const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
		setValue(e.target.value)
	}, [])

	return (
		<form
			onSubmit={handleSubmit}
			className="flex flex-col gap-1 rounded-lg border border-border bg-bg-surface p-2"
		>
			<div className="flex items-end gap-2">
				<Textarea
					rows={1}
					autoResize
					value={value}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
					disabled={disabled}
					placeholder="Say what you want to happen next…"
					aria-label="New message"
					className="max-h-40 min-h-[44px] flex-1 resize-none overflow-y-auto border-0 bg-transparent text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
				/>
				<button
					type="submit"
					disabled={!canSend}
					aria-label="Send message"
					className={cn(
						'inline-flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full transition-colors',
						canSend
							? 'bg-accent text-accent-foreground hover:bg-accent/90'
							: 'bg-muted text-muted-foreground',
					)}
				>
					{pending ? <Spinner /> : <Send size={16} aria-hidden />}
				</button>
			</div>
			{sendError ? (
				<p role="alert" className="px-1 text-error text-xs" aria-live="polite">
					{sendError} — your message is preserved; try again.
				</p>
			) : null}
		</form>
	)
}

function isTurnProgressEvent(event: ChatEvent): boolean {
	return (
		event.kind === 'text' ||
		event.kind === 'tool_use' ||
		event.kind === 'thinking' ||
		event.kind === 'result'
	)
}

const RESUME_TRUNCATE = 140
function trimForResume(text: string): string {
	const clean = text.trim().replace(/\s+/g, ' ')
	return clean.length > RESUME_TRUNCATE ? `${clean.slice(0, RESUME_TRUNCATE - 1)}…` : clean
}

function stateAsResumeLine(status: string, cosName?: string): string {
	switch (status) {
		case 'running':
			return cosName ? `${cosName} is working on this now` : 'Agent is working on this now'
		case 'starting':
		case 'waiting':
			return cosName ? `${cosName} is spinning up — hang tight` : 'Session is spinning up'
		case 'completed':
			return 'This thread is finished — reply to reopen it'
		case 'paused':
			return 'Paused — reply to resume'
		case 'failed':
		case 'timeout':
			return 'Something went wrong — reply to retry'
		default:
			return 'Waiting on you'
	}
}
