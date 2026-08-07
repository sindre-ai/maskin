import { Composer } from '@/components/chat/chat'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useCreateConversation } from '@/hooks/use-conversations'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import { getStoredActor } from '@/lib/auth'
import {
	EMPTY_CHAT_SELECTION,
	buildOneShotActionPrompt,
	chatSelectionReducer,
} from '@/lib/chat-selection'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Command } from 'cmdk'
import { X } from 'lucide-react'
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

const QUICK_START_CHIPS = [
	'Help me plan a new bet',
	"What's the status on our current bets?",
] as const

interface Participant {
	id: string
	name: string
	type: string
}

function deriveTitle(participants: Participant[], firstMessage: string): string {
	if (participants.length > 0) return participants.map((p) => p.name).join(', ')
	return firstMessage.slice(0, 60)
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
	const [chipSending, setChipSending] = useState(false)

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
			if (participants.length === 0) {
				const err = new Error('Add at least one person or agent to start the conversation')
				setError(err.message)
				throw err
			}
			const objects = seedObject ? [seedObject] : selection.objects
			const notifications = seedNotification ? [seedNotification] : selection.notifications
			const hasContext = objects.length > 0 || notifications.length > 0
			const initialMessage = hasContext
				? buildOneShotActionPrompt(content, objects, notifications, [])
				: content
			try {
				const conversation = await createConversation.mutateAsync({
					title: deriveTitle(participants, content),
					participant_actor_ids: participants.map((p) => p.id),
					initial_message: initialMessage,
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
			seedObject,
			seedNotification,
			selection,
			createConversation,
			navigate,
			workspaceId,
		],
	)

	const handleChipClick = useCallback(
		async (text: string) => {
			setChipSending(true)
			try {
				await handleSend(text)
			} catch {
				// error already surfaced via `error` state
			} finally {
				setChipSending(false)
			}
		},
		[handleSend],
	)

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-12 shrink-0 items-center border-b border-border px-3">
				<h1 className="text-sm font-semibold">New chat</h1>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
				<div className="flex flex-col gap-1.5">
					<span className="text-xs font-medium text-muted-foreground">To</span>
					<div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-bg-surface p-2">
						{participants.map((p) => (
							<span
								key={p.id}
								className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-2 py-0.5 text-xs"
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
					{participants.length > 0 ? (
						<div className="flex flex-wrap gap-1.5">
							{QUICK_START_CHIPS.map((chip) => (
								<Button
									key={chip}
									type="button"
									variant="outline"
									size="sm"
									onClick={() => void handleChipClick(chip)}
									disabled={chipSending || createConversation.isPending}
								>
									{chip}
								</Button>
							))}
						</div>
					) : null}
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
					/>
				</div>
			</div>
		</div>
	)
}
