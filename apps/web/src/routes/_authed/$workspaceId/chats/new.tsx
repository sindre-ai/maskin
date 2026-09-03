import { Composer } from '@/components/chat/chat'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { useActors, useDefaultChatAgent } from '@/hooks/use-actors'
import { useCreateConversation } from '@/hooks/use-conversations'
import { useObjects } from '@/hooks/use-objects'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import type { MessageMetadata } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import {
	EMPTY_CHAT_SELECTION,
	MAX_CHAT_OBJECT_REFERENCES,
	chatSelectionReducer,
} from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { deriveConversationTitle } from '@/lib/conversation-title'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChevronDown, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'

interface NewChatSearch {
	agentId?: string
	agentName?: string
	/** Comma-separated object ids, from the Objects page's "Ask an agent". */
	objectIds?: string
	objectId?: string
	objectTitle?: string
	objectType?: string
	notificationId?: string
	notificationTitle?: string
}

export const Route = createFileRoute('/_authed/$workspaceId/chats/new')({
	component: NewChatRoute,
	validateSearch: (search: Record<string, unknown>): NewChatSearch => ({
		agentId: typeof search.agentId === 'string' ? search.agentId : undefined,
		agentName: typeof search.agentName === 'string' ? search.agentName : undefined,
		objectIds: typeof search.objectIds === 'string' ? search.objectIds : undefined,
		objectId: typeof search.objectId === 'string' ? search.objectId : undefined,
		objectTitle: typeof search.objectTitle === 'string' ? search.objectTitle : undefined,
		objectType: typeof search.objectType === 'string' ? search.objectType : undefined,
		notificationId: typeof search.notificationId === 'string' ? search.notificationId : undefined,
		notificationTitle:
			typeof search.notificationTitle === 'string' ? search.notificationTitle : undefined,
	}),
})

/**
 * Zero-state suggestions (mockup 6143–6150). Clicking one *prefills* the
 * composer — it never sends, so the draft is still editable before it goes.
 *
 * `who` is the agent the mockup attributes the question to. The prototype's
 * cast (Forge, Sentinel, Relay, Compass) isn't seeded into real workspaces, so
 * a name is only shown when an agent by that name actually exists here;
 * otherwise the row falls back to whoever the chat is currently addressed to,
 * which is who would in fact answer it.
 */
const CHAT_SUGGESTIONS = [
	{ text: 'What needs a decision from me today?', who: 'Chief of Staff' },
	{ text: 'Summarise what the loops did overnight', who: 'Chief of Staff' },
	{ text: 'Why is the retry window still open?', who: 'Forge' },
	{ text: 'Which accounts went quiet this week?', who: 'Sentinel' },
	{ text: "Draft Acme's note before Thursday", who: 'Relay' },
	{ text: 'Turn the onboarding cluster into a bet', who: 'Compass' },
] as const

interface Recipient {
	id: string
	name: string
	type: string
	description?: string | null
}

function NewChatRoute() {
	const { workspaceId } = useWorkspace()
	const search = Route.useSearch()
	const navigate = useNavigate()
	const createConversation = useCreateConversation(workspaceId)
	const { data: members } = useWorkspaceMembers(workspaceId)
	const { data: actors } = useActors(workspaceId, { enabled: true })
	const defaultAgent = useDefaultChatAgent()
	const currentActor = getStoredActor()

	const [pickedId, setPickedId] = useState<string | null>(search.agentId ?? null)
	const [pickerOpen, setPickerOpen] = useState(false)
	const [selection, dispatchSelection] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	const [error, setError] = useState<string | null>(null)
	const [draft, setDraft] = useState('')

	// Objects handed over by "Ask an agent". Resolved so the chips read as
	// titles rather than raw ids, then dispatched into the composer's selection
	// once, so they are removable like any other reference.
	const referencedIds = useMemo(
		() => (search.objectIds ? search.objectIds.split(',').filter(Boolean) : []),
		[search.objectIds],
	)
	// `limit` is explicit because the endpoint's default is 50 — well under the
	// selection sizes `Select all` produces. Without it a larger hand-over
	// resolved its first fifty ids and dropped the rest with no chip and no
	// message; the id list in the URL still said otherwise.
	const { data: referencedObjects } = useObjects(
		workspaceId,
		{ ids: referencedIds.join(','), limit: String(MAX_CHAT_OBJECT_REFERENCES) },
		{ enabled: referencedIds.length > 0 },
	)
	const seededRef = useRef(false)
	useEffect(() => {
		if (seededRef.current || referencedIds.length === 0 || !referencedObjects) return
		seededRef.current = true
		for (const object of referencedObjects) {
			dispatchSelection({
				type: 'add_object',
				object: { id: object.id, title: object.title, type: object.type },
			})
		}
		// An id can also fail to resolve for reasons the cap has nothing to do
		// with — deleted since the link was made, or belonging to another
		// workspace. Either way the chat is about to carry fewer objects than the
		// user picked, so say which, rather than letting the count quietly shrink.
		const missing = referencedIds.length - referencedObjects.length
		if (missing > 0) {
			toast.warning(
				`${missing} of ${referencedIds.length} objects couldn't be attached — they may have been deleted.`,
			)
		}
	}, [referencedIds, referencedObjects])

	const seedObject = search.objectId
		? { id: search.objectId, title: search.objectTitle ?? null, type: search.objectType ?? null }
		: null
	const seedNotification = search.notificationId
		? { id: search.notificationId, title: search.notificationTitle ?? null }
		: null

	// Agents first, then the workspace's people — the mockup's picker is a list
	// of who can answer, and an agent is the common case.
	const candidates = useMemo<Recipient[]>(() => {
		const agents: Recipient[] = (actors ?? [])
			.filter((a) => a.type === 'agent')
			.map((a) => ({ id: a.id, name: a.name, type: a.type, description: a.description }))
		const people: Recipient[] = (members ?? [])
			.filter((m) => m.actorId !== currentActor?.id && m.type !== 'agent')
			.map((m) => ({ id: m.actorId, name: m.name, type: m.type, description: m.role }))
		const byId = new Map<string, Recipient>()
		for (const r of [...agents, ...people]) if (!byId.has(r.id)) byId.set(r.id, r)
		return Array.from(byId.values())
	}, [actors, members, currentActor])

	// The URL's agentId wins, then an explicit pick, then the workspace's
	// default chat agent. `agentName` covers the first paint, before the actors
	// query has resolved and the pill would otherwise read "Agent".
	const recipient = useMemo<Recipient | null>(() => {
		const targetId = pickedId ?? defaultAgent?.id ?? null
		if (targetId) {
			const found = candidates.find((c) => c.id === targetId)
			if (found) return found
			if (targetId === search.agentId) {
				return { id: targetId, name: search.agentName ?? 'Agent', type: 'agent' }
			}
			if (targetId === defaultAgent?.id) {
				return { id: defaultAgent.id, name: defaultAgent.name, type: 'agent' }
			}
		}
		return candidates.find((c) => c.type === 'agent') ?? candidates[0] ?? null
	}, [pickedId, defaultAgent, candidates, search.agentId, search.agentName])

	const agentNames = useMemo(
		() => new Map(candidates.map((c) => [c.name.toLowerCase(), c.name])),
		[candidates],
	)

	const handleSend = useCallback(
		async (content: string) => {
			setError(null)
			// The Composer's "Agent" button (selection.agent) is a separate entry
			// point from the recipient pill above — fold it into the participant
			// list so tagging an agent there actually adds them to the
			// conversation, instead of silently doing nothing.
			const ids = new Set<string>()
			if (recipient) ids.add(recipient.id)
			if (selection.agent) ids.add(selection.agent.id)
			if (ids.size === 0) {
				const err = new Error('Add at least one person or agent to start the conversation')
				setError(err.message)
				throw err
			}
			// The seeds from ?objectId= / ?notificationId= are additions to whatever the
			// composer holds, not replacements: a user who arrives via "Ask an agent" and
			// then attaches more objects must not have those silently dropped.
			const objects =
				seedObject && !selection.objects.some((o) => o.id === seedObject.id)
					? [seedObject, ...selection.objects]
					: selection.objects
			const notifications =
				seedNotification && !selection.notifications.some((n) => n.id === seedNotification.id)
					? [seedNotification, ...selection.notifications]
					: selection.notifications

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
					title: deriveConversationTitle(content, recipient?.name ?? 'New chat'),
					participant_actor_ids: Array.from(ids),
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
		[recipient, seedObject, seedNotification, selection, createConversation, navigate, workspaceId],
	)

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center gap-2.5 border-b border-border px-[clamp(14px,3vw,28px)] py-3">
				<span className="eyebrow shrink-0 tracking-[0.16em] text-foreground">New chat</span>
				<span aria-hidden className="shrink-0 text-border-strong">
					/
				</span>
				<ResponsivePopover open={pickerOpen} onOpenChange={setPickerOpen}>
					<ResponsivePopoverTrigger asChild>
						<button
							type="button"
							title="Change who you are talking to"
							aria-label={
								recipient
									? `Talking to ${recipient.name}. Change who you are talking to`
									: 'Choose who to talk to'
							}
							className="inline-flex shrink-0 items-center gap-[7px] rounded-full border border-border bg-card py-1 pr-2.5 pl-1.5 transition-colors hover:border-foreground"
						>
							{recipient ? (
								<ActorAvatar
									id={recipient.id}
									name={recipient.name}
									type={recipient.type}
									size="sm"
								/>
							) : null}
							<span className="whitespace-nowrap text-[11.5px] font-semibold text-foreground">
								{recipient?.name ?? 'Choose an agent'}
							</span>
							<ChevronDown size={10} className="text-muted-foreground" aria-hidden />
						</button>
					</ResponsivePopoverTrigger>
					<ResponsivePopoverContent
						align="start"
						className="w-[292px] p-1.5"
						accessibleTitle="Choose who to talk to"
					>
						<div className="flex max-h-[60vh] flex-col overflow-y-auto">
							{candidates.length === 0 ? (
								<p className="px-2.5 py-2 text-sm text-muted-foreground">
									No agents or people in this workspace yet.
								</p>
							) : (
								candidates.map((c) => (
									<button
										key={c.id}
										type="button"
										onClick={() => {
											setPickedId(c.id)
											setPickerOpen(false)
										}}
										className={cn(
											'flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left hover:bg-muted',
											c.id === recipient?.id && 'bg-muted',
										)}
									>
										<ActorAvatar id={c.id} name={c.name} type={c.type} size="md" />
										<span className="min-w-0 flex-1">
											<span className="block truncate text-[12.5px] font-semibold text-foreground">
												{c.name}
											</span>
											<span className="block truncate text-[11px] text-muted-foreground">
												{c.description || (c.type === 'agent' ? 'Agent' : 'Person')}
											</span>
										</span>
									</button>
								))
							)}
						</div>
					</ResponsivePopoverContent>
				</ResponsivePopover>
				<span className="min-w-0 truncate text-xs text-muted-foreground">
					answers first, hands it on if someone else owns it
				</span>
			</div>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[clamp(14px,3vw,28px)] py-6">
				{/* `m-auto` — the mockup centres this block in the free space above
				    the composer rather than pinning it to the top. */}
				<div className="m-auto w-full max-w-[660px]">
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
								key={suggestion.text}
								type="button"
								variant="outline"
								className="h-auto w-full justify-start gap-2.5 whitespace-normal rounded-[11px] px-3.5 py-2.5 text-left text-[13px] font-normal"
								onClick={() => setDraft(suggestion.text)}
							>
								<Search size={12} className="shrink-0 text-muted-foreground" aria-hidden />
								<span className="min-w-0 flex-1">{suggestion.text}</span>
								<span className="shrink-0 text-[11px] font-normal text-muted-foreground">
									{agentNames.get(suggestion.who.toLowerCase()) ?? recipient?.name ?? ''}
								</span>
							</Button>
						))}
					</div>
				</div>
			</div>

			{/* The composer is pinned below the scroll region, gutter-aligned with
			    the header and with no divider above it (mockup 645–646). */}
			<div className="shrink-0 px-[clamp(14px,3vw,28px)] pt-2.5 pb-3.5">
				<Composer
					workspaceId={workspaceId}
					onSend={handleSend}
					disabled={createConversation.isPending}
					pending={createConversation.isPending}
					surface="sheet"
					placeholder={recipient ? `Message ${recipient.name}…` : 'Message this conversation'}
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
	)
}
