import { Composer } from '@/components/chat/chat'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { useActors, useDefaultChatAgent } from '@/hooks/use-actors'
import { useConversationsInfinite, useCreateConversation } from '@/hooks/use-conversations'
import { useObjects } from '@/hooks/use-objects'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import { deriveEntryAgentRole, trackChatSessionStarted } from '@/lib/analytics'
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
import { X } from 'lucide-react'
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from 'react'
import { toast } from 'sonner'

// Copy for the To row. The spec ships these strings; keeping them colocated
// makes them grepable when the layout below references them by name.
const chatToPh = 'Add person or agent…'
const chatGroupNote = 'Everyone sees everything'

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
	const conversationsInfinite = useConversationsInfinite(workspaceId)

	const [recipients, setRecipients] = useState<Recipient[]>([])
	const [query, setQuery] = useState('')
	const [activeIndex, setActiveIndex] = useState(0)
	const [selection, dispatchSelection] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	const [error, setError] = useState<string | null>(null)
	const [draft, setDraft] = useState('')
	const inputRef = useRef<HTMLInputElement>(null)

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

	// All possible recipients: agents + workspace people, deduped by id.
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

	// Seed the initial recipient from the URL (agentId), or fall back to the
	// workspace default chat agent — same URL contract as before, now folded
	// into a chip. `search.agentName` covers first paint before actors resolve.
	const seedInitial = useRef(false)
	useEffect(() => {
		if (seedInitial.current) return
		const targetId = search.agentId ?? defaultAgent?.id ?? null
		if (!targetId) return
		let found: Recipient | null = candidates.find((c) => c.id === targetId) ?? null
		if (!found && targetId === search.agentId) {
			found = { id: targetId, name: search.agentName ?? 'Agent', type: 'agent' }
		}
		if (!found && defaultAgent && targetId === defaultAgent.id) {
			found = { id: defaultAgent.id, name: defaultAgent.name, type: 'agent' }
		}
		if (!found) return
		seedInitial.current = true
		setRecipients([found])
	}, [search.agentId, search.agentName, defaultAgent, candidates])

	const recipientIds = useMemo(() => new Set(recipients.map((r) => r.id)), [recipients])

	// RECENT derivation: walk cached pages of ConversationListItemResponse,
	// flatten participants[], dedupe by actorId, drop self + already-picked,
	// sort desc by max lastMessageAt across appearances. First cache page (30
	// rows) is enough breadth on empty query per the spec.
	const recentCandidates = useMemo<Recipient[]>(() => {
		const pages = conversationsInfinite.data?.pages ?? []
		if (pages.length === 0) return []
		const seen = new Map<string, { recipient: Recipient; ts: number }>()
		for (const page of pages) {
			for (const conv of page.conversations) {
				const t = conv.lastMessageAt ? new Date(conv.lastMessageAt).getTime() : 0
				for (const p of conv.participants) {
					if (p.actorId === currentActor?.id) continue
					const existing = seen.get(p.actorId)
					if (!existing || t > existing.ts) {
						const enriched = candidates.find((c) => c.id === p.actorId)
						seen.set(p.actorId, {
							ts: t,
							recipient:
								enriched ?? {
									id: p.actorId,
									name: p.actorName,
									type: p.actorType,
								},
						})
					}
				}
			}
		}
		return Array.from(seen.values())
			.sort((a, b) => b.ts - a.ts)
			.map((v) => v.recipient)
			.filter((r) => !recipientIds.has(r.id))
	}, [conversationsInfinite.data, currentActor, candidates, recipientIds])

	const trimmedQuery = query.trim()
	const typedMode = trimmedQuery.length > 0

	const typedMatches = useMemo<Recipient[]>(() => {
		if (!typedMode) return []
		const needle = trimmedQuery.toLowerCase()
		return candidates.filter((c) => c.name.toLowerCase().includes(needle))
	}, [candidates, typedMode, trimmedQuery])

	const dropdownRows = typedMode ? typedMatches : recentCandidates
	// The whole dropdown block hides on the empty-RECENT case (no empty header).
	// It stays visible in typed mode so the "No agent by that name" line has a
	// place to render.
	const showDropdown = typedMode || dropdownRows.length > 0

	useEffect(() => {
		setActiveIndex(0)
	}, [dropdownRows.length, typedMode])

	const commitRecipient = useCallback((r: Recipient) => {
		setRecipients((prev) => (prev.some((p) => p.id === r.id) ? prev : [...prev, r]))
		setQuery('')
		setActiveIndex(0)
		inputRef.current?.focus()
	}, [])

	const removeRecipient = useCallback((id: string) => {
		setRecipients((prev) => prev.filter((r) => r.id !== id))
	}, [])

	const handleInputKeyDown = useCallback(
		(e: ReactKeyboardEvent<HTMLInputElement>) => {
			if (e.key === 'ArrowDown') {
				if (dropdownRows.length === 0) return
				e.preventDefault()
				setActiveIndex((i) => (i + 1) % dropdownRows.length)
				return
			}
			if (e.key === 'ArrowUp') {
				if (dropdownRows.length === 0) return
				e.preventDefault()
				setActiveIndex((i) => (i - 1 + dropdownRows.length) % dropdownRows.length)
				return
			}
			if (e.key === 'Enter') {
				const row = dropdownRows[activeIndex]
				if (row) {
					e.preventDefault()
					commitRecipient(row)
				}
				return
			}
			if (e.key === 'Backspace' && query.length === 0 && recipients.length > 0) {
				// Caret at position 0 pops the last chip — no beep, no navigation.
				e.preventDefault()
				setRecipients((prev) => prev.slice(0, -1))
			}
		},
		[dropdownRows, activeIndex, query, recipients, commitRecipient],
	)

	const handleSend = useCallback(
		async (content: string) => {
			setError(null)
			// The Composer's "Agent" button (selection.agent) is a separate entry
			// point from the chip picker above — fold it into the participant
			// list so tagging an agent there actually adds them to the
			// conversation, instead of silently doing nothing.
			const ids = new Set<string>()
			for (const r of recipients) ids.add(r.id)
			if (selection.agent) ids.add(selection.agent.id)
			if (ids.size === 0) {
				const err = new Error('Add at least one person or agent to start the conversation')
				setError(err.message)
				throw err
			}

			// The seeds from ?objectId= / ?notificationId= are additions to whatever
			// the composer holds, not replacements: a user who arrives via "Ask an
			// agent" and then attaches more objects must not have those silently
			// dropped.
			const objects =
				seedObject && !selection.objects.some((o) => o.id === seedObject.id)
					? [seedObject, ...selection.objects]
					: selection.objects
			const notifications =
				seedNotification && !selection.notifications.some((n) => n.id === seedNotification.id)
					? [seedNotification, ...selection.notifications]
					: selection.notifications

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
					title: deriveConversationTitle(content, recipients[0]?.name ?? 'New chat'),
					participant_actor_ids: Array.from(ids),
					initial_message: content,
					...(Object.keys(metadata).length > 0 ? { initial_message_metadata: metadata } : {}),
				})
				const singleAgent =
					recipients.length === 1 && recipients[0].type === 'agent' ? recipients[0] : null
				trackChatSessionStarted({
					entity_id: conversation.id,
					entity_type: 'session',
					entry_point: 'agent_one_shot',
					entry_agent_role: singleAgent ? deriveEntryAgentRole(singleAgent.name) : null,
					participant_count: ids.size,
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
		[recipients, seedObject, seedNotification, selection, createConversation, navigate, workspaceId],
	)

	const composerPlaceholder =
		recipients.length === 1 ? `Message ${recipients[0].name}…` : 'Message this conversation'

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center gap-2.5 border-b border-border px-[clamp(14px,3vw,28px)] py-3">
				<span className="eyebrow shrink-0 tracking-[0.16em] text-foreground">NEW CHAT</span>
				<span aria-hidden className="shrink-0 text-border-strong">
					/
				</span>
				<span className="min-w-0 truncate text-xs text-muted-foreground">
					it becomes a conversation you can come back to
				</span>
			</div>

			<div className="relative flex shrink-0 flex-col gap-1.5 border-b border-border px-[clamp(14px,3vw,28px)] py-2.5">
				<div className="flex flex-wrap items-center gap-1.5">
					{recipients.map((r) => (
						<span
							key={r.id}
							className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card py-0.5 pr-1 pl-1"
						>
							<ActorAvatar id={r.id} name={r.name} type={r.type} size="sm" />
							<span className="max-w-[16ch] truncate text-[12px] font-semibold text-foreground">
								{r.name}
							</span>
							<button
								type="button"
								onClick={() => removeRecipient(r.id)}
								aria-label={`Remove ${r.name}`}
								className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<X size={10} aria-hidden />
							</button>
						</span>
					))}
					<input
						ref={inputRef}
						type="text"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={handleInputKeyDown}
						placeholder={recipients.length === 0 ? chatToPh : ''}
						aria-label="Add recipients"
						aria-autocomplete="list"
						className="min-w-[10ch] flex-1 border-none bg-transparent px-1 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
					/>
					{recipients.length >= 2 ? (
						<span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
							{chatGroupNote}
						</span>
					) : null}
				</div>

				{showDropdown ? (
					<div className="mt-1 rounded-[11px] border border-border bg-card p-1.5">
						<div className="eyebrow px-1.5 pt-1 pb-1.5">
							{typedMode ? 'ADD SOMEONE — PERSON OR AGENT' : 'RECENT'}
						</div>
						{dropdownRows.length === 0 ? (
							<p className="px-1.5 py-4 text-center text-[12px] text-muted-foreground">
								No agent by that name
							</p>
						) : (
							<ul
								role="listbox"
								aria-label={typedMode ? 'Add someone — person or agent' : 'Recent collaborators'}
								className={cn(
									'flex list-none flex-col gap-0.5 overflow-y-auto p-0',
									// Desktop: single column, max 8 rows before scroll.
									'max-h-[calc(8*40px)]',
									// Tablet 641–1024px: 2-col when RECENT has >4 rows.
									!typedMode && dropdownRows.length > 4
										? 'md:grid md:max-h-[calc(4*40px)] md:grid-cols-2 lg:flex lg:max-h-[calc(8*40px)]'
										: undefined,
								)}
							>
								{dropdownRows.map((row, i) => {
									const selected = recipientIds.has(row.id)
									return (
										<li key={row.id}>
											<button
												type="button"
												role="option"
												aria-selected={i === activeIndex}
												onMouseEnter={() => setActiveIndex(i)}
												onClick={() => commitRecipient(row)}
												className={cn(
													'flex w-full items-center gap-2.5 rounded-[9px] px-1.5 py-1.5 text-left hover:bg-muted',
													i === activeIndex && 'bg-muted',
												)}
											>
												<ActorAvatar id={row.id} name={row.name} type={row.type} size="md" />
												<span className="min-w-0 flex-1">
													<span className="block truncate text-[12.5px] font-semibold text-foreground">
														{row.name}
													</span>
													<span className="block truncate text-[11px] text-muted-foreground">
														{row.description || (row.type === 'agent' ? 'Agent' : 'Person')}
													</span>
												</span>
												<span
													className={cn(
														'inline-flex items-center rounded-full border border-border px-1.5 py-[1px] text-[9.5px] font-bold uppercase tracking-[0.06em]',
														row.type === 'agent'
															? 'bg-muted text-foreground'
															: 'bg-card text-muted-foreground',
													)}
												>
													{row.type === 'agent' ? 'Agent' : 'Person'}
												</span>
												{selected ? (
													<span aria-hidden className="shrink-0 text-foreground">
														✓
													</span>
												) : null}
											</button>
										</li>
									)
								})}
							</ul>
						)}
					</div>
				) : null}
			</div>

			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[clamp(14px,3vw,28px)] py-6">
				<div className="m-auto w-full max-w-[660px]">
					<h2 className="text-[clamp(20px,2.4vw,26px)] font-bold leading-tight tracking-[-0.025em]">
						What are we working on?
					</h2>
					<p className="mt-2 max-w-[52ch] text-[13.5px] leading-relaxed text-balance text-muted-foreground">
						Your agents are already inside the work — the loops they run, the objects they keep
						current, the sessions live right now. You don't have to paste any of it in.
					</p>
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
					placeholder={composerPlaceholder}
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
