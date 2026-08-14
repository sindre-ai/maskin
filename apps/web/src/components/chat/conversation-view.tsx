import { ConversationHeader } from '@/components/chat/conversation-header'
import type { Participant } from '@/components/chat/in-this-chat-panel'
import { ResumeBand, type ResumeItem } from '@/components/chat/resume-band'
import { EmptyState } from '@/components/shared/empty-state'
import { Textarea } from '@/components/ui/textarea'
import { useActors } from '@/hooks/use-actors'
import { useLoop } from '@/hooks/use-loops'
import { deriveEntryAgentRole } from '@/lib/analytics'
import type { ActorListItem, SessionResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { Send } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

interface ConversationViewProps {
	workspaceId: string
	session: SessionResponse
	/** All workspace actors, used by the add-someone search. Passed by the route. */
	actors: ActorListItem[]
	className?: string
}

/**
 * T3 conversation-view shell. Owns the header (back / title / participant
 * stack / IN THIS CHAT panel / loop chip / Chief of Staff attribution row),
 * the PICKING UP WHERE YOU LEFT OFF resume band, and a visual composer with
 * the CoS routing prefix. Message-type rendering (T1) and streaming
 * (T4) stay separate — this view carries the shell around them.
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

	// The persistent chat agent (workspace default) travels on the session
	// config as `entry_agent_role`. When that role is `chief-of-staff` we treat
	// the session as CoS-routed even if the actor row isn't in this fetch.
	const config = session.config as Record<string, unknown> | null
	const configRole =
		typeof config?.entry_agent_role === 'string' ? (config.entry_agent_role as string) : null
	const isChiefOfStaff = configRole === 'chief-of-staff' || sessionAgentRole === 'chief-of-staff'

	// Loop context — sessions can carry a `loop_id` on config when they were
	// spun up as part of a loop's execution. Present it as a compact chip when
	// the loop resolves in the workspace.
	const loopId = typeof config?.loop_id === 'string' ? (config.loop_id as string) : null
	const { data: loop } = useLoop(loopId ?? '', workspaceId)
	const loopContext = loopId && loop ? { id: loopId, name: loop.name } : null

	const chiefOfStaff = useMemo(() => {
		if (!isChiefOfStaff) return null
		// Prefer the session's own agent; fall back to any workspace actor named
		// "Chief of Staff" — matches the resolver in $workspaceId.tsx.
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

	// Participants: local state so add/remove work without a server round-trip
	// (there's no multi-participant table today — the DoD says the controls
	// "work", not that the change persists).
	const owner = getStoredActor()

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

	// Reset participants when navigating between sessions.
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

	// The composer send is intentionally out of scope per the task brief
	// (Composer/attach flow) — the prefix + textarea render for visual parity
	// and the send button stays disabled. T4 wires streaming input; the
	// existing <Chat> primitive is the right surface for a follow-up.
	const composerPrefix = chiefOfStaff
		? `Replying to ${chiefOfStaff.name} · she'll route it if a specialist is needed`
		: 'Replying to this conversation'

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
				<div className="mx-auto flex max-w-3xl flex-col gap-4">
					<ResumeBand items={resumeItems} lastActivityAt={lastActivityAt} />
					<EmptyState
						title="Message rendering ships next"
						description="Streaming replies, references, attachments and inline blocks land in a follow-up. Reopen this chat from the Chats list to see updates."
					/>
				</div>
			</div>
			<div className="border-t border-border bg-background px-4 py-3 md:px-6">
				<div className="mx-auto max-w-3xl">
					<p className="pb-1 text-[11px] text-muted-foreground">
						{chiefOfStaff ? (
							<>
								Replying to{' '}
								<span className="font-semibold text-[color:var(--color-cos)]">
									{chiefOfStaff.name}
								</span>{' '}
								· she&apos;ll route it if a specialist is needed
							</>
						) : (
							composerPrefix
						)}
					</p>
					<div className="flex items-end gap-2 rounded-lg border border-border bg-bg-surface p-2">
						<Textarea
							rows={1}
							disabled
							placeholder="Say what you want to happen next…"
							aria-label="New message"
							className="min-h-[44px] flex-1 resize-none border-0 bg-transparent text-sm focus-visible:ring-0"
						/>
						<button
							type="button"
							disabled
							aria-label="Send message"
							className="inline-flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-muted text-muted-foreground"
						>
							<Send size={16} aria-hidden />
						</button>
					</div>
				</div>
			</div>
		</div>
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
