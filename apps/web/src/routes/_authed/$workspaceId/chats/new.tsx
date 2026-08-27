import { Composer } from '@/components/chat/chat'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useCreateConversation } from '@/hooks/use-conversations'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import type { MessageMetadata } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { EMPTY_CHAT_SELECTION, chatSelectionReducer } from '@/lib/chat-selection'
import { useWorkspace } from '@/lib/workspace-context'
import { NEW_CONVERSATION_PLACEHOLDER_TITLE } from '@maskin/shared'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Command } from 'cmdk'
import { Search, X } from 'lucide-react'
import { useCallback, useMemo, useReducer, useState } from 'react'

interface NewChatSearch {
	agentId?: string
	agentName?: string
	objectId?: string
	objectTitle?: string
	objectType?: string
	notificationId?: string
	notificationTitle?: string
}

export const Route = createFileRoute('/_authed/$workspaceId/chats/new')({
	component: NewConversationPage,
	validateSearch: (search: Record<string, unknown>): NewChatSearch => ({
		agentId: typeof search.agentId === 'string' ? search.agentId : undefined,
		agentName: typeof search.agentName === 'string' ? search.agentName : undefined,
		objectId: typeof search.objectId === 'string' ? search.objectId : undefined,
		objectTitle: typeof search.objectTitle === 'string' ? search.objectTitle : undefined,
		objectType: typeof search.objectType === 'string' ? search.objectType : undefined,
		notificationId: typeof search.notificationId === 'string' ? search.notificationId : undefined,
		notificationTitle:
			typeof search.notificationTitle === 'string' ? search.notificationTitle : undefined,
	}),
})

// Zero-state suggestions (mockup 739–748). Clicking one *prefills* the
// composer — it never sends, so the draft is still editable before it goes.
const CHAT_SUGGESTIONS = [
	'Catch me up on billing',
	'Why is the retry window still open?',
	"Draft Acme's note before Thursday",
	'Which accounts went quiet this week?',
	'Turn the onboarding cluster into a bet',
] as const

interface Participant {
	id: string
	name: string
	type: string
}

function NewConversationPage() {
	const { workspaceId } = useWorkspace()
	const search = Route.useSearch()
	const navigate = useNavigate()
	const createConversation = useCreateConversation(workspaceId)
	const { data: members } = useWorkspaceMembers(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const currentActor = getStoredActor()

	const [participants, setParticipants] = useState<Participant[]>(() =>
		search.agentId
			? [{ id: search.agentId, name: search.agentName ?? 'Agent', type: 'agent' }]
			: [],
	)
	const [query, setQuery] = useState('')
	const [isPickerFocused, setIsPickerFocused] = useState(false)
	const [selection, dispatchSelection] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	const [error, setError] = useState<string | null>(null)
	const [draft, setDraft] = useState('')

	const seedObject = search.objectId
		? { id: search.objectId, title: search.objectTitle ?? null, type: search.objectType ?? null }
		: null
	const seedNotification = search.notificationId
		? { id: search.notificationId, title: search.notificationTitle ?? null }
		: null

	const participantIds = useMemo(() => new Set(participants.map((p) => p.id)), [participants])

	const candidates = useMemo(() => {
		const byId = new Map<string, Participant>()
		for (const m of members ?? []) {
			if (m.actorId !== currentActor?.id && !participantIds.has(m.actorId)) {
				byId.set(m.actorId, { id: m.actorId, name: m.name, type: m.type })
			}
		}
		for (const a of actors ?? []) {
			if (a.type === 'agent' && !participantIds.has(a.id)) {
				byId.set(a.id, { id: a.id, name: a.name, type: a.type })
			}
		}
		const needle = query.trim().toLowerCase()
		const all = Array.from(byId.values())
		return needle ? all.filter((c) => c.name.toLowerCase().includes(needle)) : all
	}, [members, actors, participantIds, currentActor, query])

	const handleAddParticipant = useCallback((p: Participant) => {
		setParticipants((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]))
		setQuery('')
	}, [])

	const handleRemoveParticipant = useCallback((id: string) => {
		setParticipants((prev) => prev.filter((p) => p.id !== id))
	}, [])

	const handleSend = useCallback(
		async (content: string) => {
			setError(null)
			// The Composer's "Agent" button (selection.agent) is a separate entry
			// point from the "To" field above — fold it into the participant list
			// so tagging an agent there actually adds them to the conversation,
			// instead of silently doing nothing.
			const taggedAgent =
				selection.agent && !participantIds.has(selection.agent.id)
					? [{ id: selection.agent.id, name: selection.agent.name ?? 'Agent', type: 'agent' }]
					: []
			const allParticipants = [...participants, ...taggedAgent]
			if (allParticipants.length === 0) {
				const err = new Error('Add at least one person or agent to start the conversation')
				setError(err.message)
				throw err
			}
			const objects = seedObject ? [seedObject] : selection.objects
			const notifications = seedNotification ? [seedNotification] : selection.notifications

			// Sent as structured metadata (rendered as chips by MessageBubble)
			// rather than inlined into the message text.
			const metadata: MessageMetadata = {}
			if (selection.files.length > 0) {
				metadata.attachments = selection.files.map((f) => ({
					file_id: f.fileId,
					name: f.name,
					mime_type: f.mimeType ?? 'application/octet-stream',
					size_bytes: f.sizeBytes,
				}))
			}
			if (objects.length > 0) {
				metadata.context_objects = objects.map((o) => ({
					id: o.id,
					...(o.title ? { title: o.title } : {}),
					...(o.type ? { type: o.type } : {}),
				}))
			}
			if (notifications.length > 0) {
				metadata.context_notifications = notifications.map((n) => ({
					id: n.id,
					...(n.title ? { title: n.title } : {}),
				}))
			}

			try {
				const conversation = await createConversation.mutateAsync({
					title: NEW_CONVERSATION_PLACEHOLDER_TITLE,
					participant_actor_ids: allParticipants.map((p) => p.id),
					initial_message: content,
					...(Object.keys(metadata).length > 0 ? { initial_message_metadata: metadata } : {}),
				})
				dispatchSelection({ type: 'clear_all' })
				navigate({
					to: '/$workspaceId/chats/$conversationId',
					params: { workspaceId, conversationId: conversation.id },
				})
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to create conversation')
				throw err
			}
		},
		[
			participants,
			participantIds,
			seedObject,
			seedNotification,
			selection,
			createConversation,
			navigate,
			workspaceId,
		],
	)

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center gap-2.5 border-b border-border px-[clamp(14px,3vw,28px)] py-3">
				<span className="eyebrow tracking-[0.16em] text-foreground">New chat</span>
				<span aria-hidden className="text-border-strong">
					/
				</span>
				<span className="min-w-0 truncate text-xs text-muted-foreground">
					it becomes a conversation you can come back to
				</span>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-[clamp(14px,3vw,28px)] py-6">
				<div className="mx-auto w-full max-w-[660px]">
					<h2 className="text-[clamp(20px,2.4vw,26px)] font-bold leading-tight tracking-[-0.025em]">
						What are we working on?
					</h2>
					<p className="mt-2 max-w-[52ch] text-[13.5px] leading-relaxed text-balance text-muted-foreground">
						Your agents are already inside the work — the loops they run, the objects they keep
						current, the sessions live right now. You don't have to paste any of it in.
					</p>
					<div className="mt-5 flex flex-col gap-1.5">
						{CHAT_SUGGESTIONS.map((suggestion) => (
							<Button
								key={suggestion}
								type="button"
								variant="outline"
								className="h-auto w-full justify-start gap-2.5 whitespace-normal rounded-[11px] px-3.5 py-2.5 text-left text-[13px] font-normal"
								onClick={() => setDraft(suggestion)}
							>
								<Search size={12} className="shrink-0 text-muted-foreground" aria-hidden />
								<span className="min-w-0 flex-1">{suggestion}</span>
							</Button>
						))}
					</div>
				</div>
				<div className="mx-auto flex w-full max-w-[660px] flex-col gap-1.5">
					<span className="text-xs font-medium text-muted-foreground">To</span>
					<div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-card p-2">
						{participants.map((p) => (
							<span
								key={p.id}
								className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-xs"
							>
								<ActorAvatar id={p.id} name={p.name} type={p.type} size="sm" />
								{p.name}
								<button
									type="button"
									onClick={() => handleRemoveParticipant(p.id)}
									aria-label={`Remove ${p.name}`}
									className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
								>
									<X size={10} aria-hidden />
								</button>
							</span>
						))}
						<Command shouldFilter={false} className="min-w-[10rem] flex-1">
							<Command.Input
								value={query}
								onValueChange={setQuery}
								placeholder="Add people or agents…"
								aria-label="Add people or agents"
								onFocus={() => setIsPickerFocused(true)}
								onBlur={() => setIsPickerFocused(false)}
								className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
							/>
							{isPickerFocused ? (
								<Command.List
									onMouseDown={(e) => e.preventDefault()}
									className="mt-1 max-h-48 overflow-auto rounded-md border border-border bg-popover shadow-sm"
								>
									{candidates.length === 0 ? (
										<div className="px-2 py-2 text-sm text-muted-foreground">No matches.</div>
									) : (
										candidates.map((c) => (
											<Command.Item
												key={c.id}
												value={c.id}
												onSelect={() => handleAddParticipant(c)}
												className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
											>
												<ActorAvatar id={c.id} name={c.name} type={c.type} size="sm" />
												{c.name}
											</Command.Item>
										))
									)}
								</Command.List>
							) : null}
						</Command>
					</div>
				</div>

				<div className="flex flex-1 flex-col justify-end gap-3">
					<Composer
						workspaceId={workspaceId}
						onSend={handleSend}
						disabled={createConversation.isPending}
						pending={createConversation.isPending}
						surface="sheet"
						placeholder="Message this conversation"
						selection={selection}
						onDispatchSelection={dispatchSelection}
						onRemoveAgent={() => dispatchSelection({ type: 'remove_agent' })}
						onRemoveObject={(id) => dispatchSelection({ type: 'remove_object', id })}
						onRemoveNotification={(id) => dispatchSelection({ type: 'remove_notification', id })}
						onRemoveFile={(fileId) => dispatchSelection({ type: 'remove_file', fileId })}
						externalError={error}
						onDismissExternalError={() => setError(null)}
						textareaLabel="Message this conversation"
						value={draft}
						onValueChange={setDraft}
					/>
				</div>
			</div>
		</div>
	)
}
