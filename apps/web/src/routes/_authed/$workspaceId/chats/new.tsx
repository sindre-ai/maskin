import { Composer } from '@/components/chat/chat'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Input } from '@/components/ui/input'
import { useActors, useDefaultChatAgent } from '@/hooks/use-actors'
import { useCreateConversation } from '@/hooks/use-conversations'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useObjects } from '@/hooks/use-objects'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import { deriveEntryAgentRole, trackChatSessionStarted } from '@/lib/analytics'
import type { MessageMetadata } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import {
	type ChatSelectionAction,
	type ChatSelectionFile,
	EMPTY_CHAT_SELECTION,
	MAX_CHAT_OBJECT_REFERENCES,
	chatSelectionReducer,
} from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { deriveConversationTitle } from '@maskin/shared'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChevronLeft, X } from 'lucide-react'
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useReducer,
	useRef,
	useState,
} from 'react'
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
	/** Text that fills the message box. Nothing is sent until the viewer sends it. */
	text?: string
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
		text: typeof search.text === 'string' ? search.text : undefined,
	}),
})

interface Recipient {
	id: string
	name: string
	type: string
}

const MAX_SUGGESTIONS = 6

function NewChatRoute() {
	useDocumentTitle('New chat')
	const search = Route.useSearch()
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const createConversation = useCreateConversation(workspaceId)
	const { data: members } = useWorkspaceMembers(workspaceId)
	const { data: actors } = useActors(workspaceId, { enabled: true })
	const defaultAgent = useDefaultChatAgent()
	const currentActor = getStoredActor()

	const [pickedIds, setPickedIds] = useState<string[]>([])
	const [selection, dispatchSelection] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	const [error, setError] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [toFocused, setToFocused] = useState(false)
	const [activeIndex, setActiveIndex] = useState(0)
	const listboxId = useId()
	const toInputRef = useRef<HTMLInputElement>(null)
	// True once the person arrowed through the list, so Enter on an empty field picks the row they chose.
	const arrowedRef = useRef(false)
	// The box takes focus on open: bumping the nonce after mount is what the composer treats as
	// a request (a nonce already present on mount never fires).
	const [focusNonce, setFocusNonce] = useState(0)
	useEffect(() => setFocusNonce(1), [])
	const [draft, setDraft] = useState(search.text ?? '')
	// The page stays mounted when the launcher opens /chats/new?text=... from
	// here, so a new text has to replace the box; the initial value covers mount.
	useEffect(() => {
		if (search.text !== undefined) setDraft(search.text)
	}, [search.text])

	// Objects handed over by "Ask an agent". Resolved so the rows read as titles
	// rather than raw ids, then dispatched into the selection once, so they are
	// removable like any other reference.
	const referencedIds = useMemo(
		() => (search.objectIds ? search.objectIds.split(',').filter(Boolean) : []),
		[search.objectIds],
	)
	// `limit` is explicit because the endpoint's default is 50 — well under the
	// selection sizes `Select all` produces.
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
		// An id can also fail to resolve — deleted since the link was made, or
		// belonging to another workspace. Say so, rather than letting the count
		// quietly shrink.
		const missing = referencedIds.length - referencedObjects.length
		if (missing > 0) {
			toast.warning(
				`${missing} of ${referencedIds.length} items couldn't be attached — they may have been deleted.`,
			)
		}
	}, [referencedIds, referencedObjects])

	// The single-object and notification hand-overs land in the same selection.
	const seededSingleRef = useRef(false)
	useEffect(() => {
		if (seededSingleRef.current) return
		seededSingleRef.current = true
		if (search.objectId) {
			dispatchSelection({
				type: 'add_object',
				object: {
					id: search.objectId,
					title: search.objectTitle ?? null,
					type: search.objectType ?? null,
				},
			})
		}
		if (search.notificationId) {
			dispatchSelection({
				type: 'add_notification',
				notification: { id: search.notificationId, title: search.notificationTitle ?? null },
			})
		}
	}, [
		search.objectId,
		search.objectTitle,
		search.objectType,
		search.notificationId,
		search.notificationTitle,
	])

	// Every agent and every other person in the workspace, A→Z, deduped by id.
	const candidates = useMemo<Recipient[]>(() => {
		const agents: Recipient[] = (actors ?? [])
			.filter((a) => a.type === 'agent')
			.map((a) => ({ id: a.id, name: a.name, type: a.type }))
		const people: Recipient[] = (members ?? [])
			.filter((m) => m.actorId !== currentActor?.id && m.type !== 'agent' && m.type !== 'system')
			.map((m) => ({ id: m.actorId, name: m.name, type: m.type }))
		const byId = new Map<string, Recipient>()
		for (const r of [...agents, ...people]) if (!byId.has(r.id)) byId.set(r.id, r)
		return Array.from(byId.values()).sort(
			(a, b) =>
				a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) ||
				a.id.localeCompare(b.id),
		)
	}, [actors, members, currentActor?.id])

	// Seed the initial pick from the URL (agentId), or fall back to the workspace
	// default chat agent — same URL contract as before.
	const seedInitial = useRef(false)
	useEffect(() => {
		if (seedInitial.current) return
		const targetId = search.agentId ?? defaultAgent?.id ?? null
		if (!targetId) return
		seedInitial.current = true
		setPickedIds([targetId])
	}, [search.agentId, defaultAgent])

	// A seeded agent can be missing from the lists (a stale link, or the lists
	// still loading): keep its row so the pick is visible and removable.
	const rows = useMemo<Recipient[]>(() => {
		const known = new Set(candidates.map((c) => c.id))
		const extra: Recipient[] = []
		for (const id of pickedIds) {
			if (known.has(id)) continue
			if (id === search.agentId)
				extra.push({ id, name: search.agentName ?? 'Agent', type: 'agent' })
			else if (defaultAgent && id === defaultAgent.id) {
				extra.push({ id, name: defaultAgent.name, type: 'agent' })
			}
		}
		return [...candidates, ...extra]
	}, [candidates, pickedIds, search.agentId, search.agentName, defaultAgent])

	const picked = useMemo(() => rows.filter((r) => pickedIds.includes(r.id)), [rows, pickedIds])

	const add = useCallback((id: string) => {
		setError(null)
		setPickedIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
		setQuery('')
		setActiveIndex(0)
		arrowedRef.current = false
	}, [])
	const remove = useCallback((id: string) => {
		setError(null)
		setPickedIds((prev) => prev.filter((p) => p !== id))
	}, [])

	// Suggested while the field is empty, matches once the person types. Everyone not already a
	// chip, A→Z (the candidates are sorted once above).
	const trimmedQuery = query.trim().toLowerCase()
	const suggestions = useMemo(
		() =>
			rows
				.filter((r) => !pickedIds.includes(r.id))
				.filter((r) => !trimmedQuery || r.name.toLowerCase().includes(trimmedQuery))
				.slice(0, MAX_SUGGESTIONS),
		[rows, pickedIds, trimmedQuery],
	)
	const listOpen = toFocused && suggestions.length > 0
	const activeSuggestion = suggestions[Math.min(activeIndex, suggestions.length - 1)]

	const onToKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		// Enter that confirms an IME composition (CJK input) must not pick a recipient.
		if (e.nativeEvent.isComposing) return
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			if (suggestions.length === 0) return
			e.preventDefault()
			arrowedRef.current = true
			const delta = e.key === 'ArrowDown' ? 1 : -1
			setActiveIndex((i) => (i + delta + suggestions.length) % suggestions.length)
		} else if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
			// Nothing typed: Tab still leaves the field, and Enter only picks after arrowing to a row.
			if (!activeSuggestion || (!trimmedQuery && !(e.key === 'Enter' && arrowedRef.current))) return
			e.preventDefault()
			add(activeSuggestion.id)
		} else if (e.key === 'Backspace' && query === '' && picked.length > 0) {
			remove(picked[picked.length - 1].id)
		} else if (e.key === 'Escape') {
			toInputRef.current?.blur()
		}
	}

	// A mention picked in the box is another recipient; everything else is the box's own selection.
	const onDispatchSelection = useCallback((action: ChatSelectionAction) => {
		if (action.type === 'add_agent') {
			setPickedIds((prev) => (prev.includes(action.agent.id) ? prev : [...prev, action.agent.id]))
			return
		}
		if (action.type === 'remove_agent') {
			setPickedIds((prev) => prev.filter((id) => id !== action.id))
			return
		}
		dispatchSelection(action)
	}, [])

	const handleSend = async (content: string, extras?: { files: ChatSelectionFile[] }) => {
		if (createConversation.isPending) return
		if (picked.length === 0) {
			const message = 'Pick at least one person or agent to start the conversation'
			setError(message)
			throw new Error(message)
		}
		setError(null)

		const metadata: MessageMetadata = {}
		const files = [...selection.files, ...(extras?.files ?? [])]
		if (files.length > 0) {
			metadata.attachments = files.map((f) => ({
				file_id: f.fileId,
				name: f.name,
				mime_type: f.mimeType ?? 'application/octet-stream',
				size_bytes: f.sizeBytes,
			}))
		}
		if (selection.objects.length > 0) {
			metadata.context_objects = selection.objects.map((o) => ({
				id: o.id,
				...(o.title ? { title: o.title } : {}),
				...(o.type ? { type: o.type } : {}),
			}))
		}
		if (selection.notifications.length > 0) {
			metadata.context_notifications = selection.notifications.map((n) => ({
				id: n.id,
				...(n.title ? { title: n.title } : {}),
			}))
		}

		try {
			const conversation = await createConversation.mutateAsync({
				title: deriveConversationTitle(content, picked[0]?.name ?? 'New chat'),
				participant_actor_ids: picked.map((r) => r.id),
				// An attachments-only send has empty text; the API accepts that when attachments ride along.
				...(content || metadata.attachments ? { initial_message: content } : {}),
				...((content || metadata.attachments) && Object.keys(metadata).length > 0
					? { initial_message_metadata: metadata }
					: {}),
			})
			const singleAgent = picked.length === 1 && picked[0]?.type === 'agent' ? picked[0] : null
			trackChatSessionStarted({
				entity_id: conversation.id,
				entity_type: 'session',
				entry_point: 'agent_one_shot',
				entry_agent_role: singleAgent ? deriveEntryAgentRole(singleAgent.name) : null,
				participant_count: picked.length,
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
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col px-4 pb-6 md:px-8 lg:px-7">
			<div>
				<Link
					to="/$workspaceId/chats"
					params={{ workspaceId }}
					className="-ml-1.5 inline-flex h-8 items-center gap-2 rounded-full pr-3 pl-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
				>
					<ChevronLeft size={14} strokeWidth={2.4} aria-hidden />
					Chats
				</Link>
			</div>
			<h1 className="page-title mt-2 max-md:sr-only">New chat</h1>

			<section aria-label="To" className="relative mt-8 flex flex-col">
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: a click anywhere in the field focuses its input; the input itself is the keyboard path */}
				<div
					onClick={() => toInputRef.current?.focus()}
					className="flex min-h-12 flex-wrap items-center gap-1.5 border-b border-border py-2.5"
				>
					<span className="pr-1 text-sm text-muted-foreground">To:</span>
					{picked.map((r) => (
						<span
							key={r.id}
							className="flex h-7 items-center gap-1.5 rounded-full bg-secondary pr-1 pl-1 text-sm font-semibold text-foreground"
						>
							<ActorAvatar id={r.id} name={r.name} type={r.type} size="sm" />
							{r.name}
							<button
								type="button"
								aria-label={`Remove ${r.name}`}
								onClick={(e) => {
									e.stopPropagation()
									remove(r.id)
								}}
								className="flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-border hover:text-foreground"
							>
								<X size={12} strokeWidth={2.4} aria-hidden />
							</button>
						</span>
					))}
					<Input
						ref={toInputRef}
						role="combobox"
						aria-label="Add a person or agent"
						aria-expanded={listOpen}
						aria-controls={listboxId}
						aria-activedescendant={
							listOpen && activeSuggestion ? `${listboxId}-${activeSuggestion.id}` : undefined
						}
						aria-autocomplete="list"
						value={query}
						onChange={(e) => {
							setQuery(e.target.value)
							setActiveIndex(0)
							arrowedRef.current = false
						}}
						onKeyDown={onToKeyDown}
						onFocus={() => setToFocused(true)}
						onBlur={() => setToFocused(false)}
						placeholder={picked.length > 0 ? 'Add another' : 'Type a name'}
						autoComplete="off"
						className="h-7 min-w-36 flex-1 border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
					/>
				</div>
				{listOpen ? (
					<div className="absolute top-full right-0 left-0 z-10 flex flex-col gap-0.5 rounded-b-xl bg-popover p-1.5 shadow-lg ring-1 ring-border">
						<div className="px-2.5 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
							{trimmedQuery ? 'Matches' : 'Suggested'}
						</div>
						{/* biome-ignore lint/a11y/useFocusableInteractive: focus stays in the To input, the listbox is never tabbed to */}
						<div
							id={listboxId}
							// biome-ignore lint/a11y/useSemanticElements: an ARIA listbox the To input controls (aria-activedescendant); <select> is for form values
							role="listbox"
							aria-label="Suggested"
						>
							{suggestions.map((r) => (
								<div
									key={r.id}
									id={`${listboxId}-${r.id}`}
									// biome-ignore lint/a11y/useSemanticElements: an option of an ARIA listbox the To input controls; <option> belongs to <select>
									role="option"
									tabIndex={-1}
									aria-selected={r.id === activeSuggestion?.id}
									// mousedown, not click: the input's blur would close the list first.
									onMouseDown={(e) => {
										e.preventDefault()
										add(r.id)
									}}
									onMouseMove={() => setActiveIndex(suggestions.indexOf(r))}
									className={cn(
										'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-secondary',
										r.id === activeSuggestion?.id && 'bg-secondary',
									)}
								>
									<ActorAvatar id={r.id} name={r.name} type={r.type} size="md" />
									<span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold text-foreground">
										{r.name}
									</span>
									<span className="text-[12.5px] text-muted-foreground">
										{r.type === 'agent' ? 'Agent' : 'Person'}
									</span>
								</div>
							))}
						</div>
					</div>
				) : null}
			</section>

			<div className="min-h-8 flex-1" />

			<Composer
				workspaceId={workspaceId}
				onSend={handleSend}
				allowAttachmentOnly
				longTextAsFile
				disabled={false}
				pending={createConversation.isPending}
				surface="sheet"
				placeholder={
					picked.length > 0
						? 'Write your first message'
						: 'Pick an agent, then write your first message'
				}
				selection={selection}
				onDispatchSelection={onDispatchSelection}
				conversationParticipantIds={[]}
				onRemoveAgent={() => {}}
				onRemoveObject={(id) => dispatchSelection({ type: 'remove_object', id })}
				onRemoveNotification={(id) => dispatchSelection({ type: 'remove_notification', id })}
				onRemoveFile={(fileId) => dispatchSelection({ type: 'remove_file', fileId })}
				externalError={error}
				onDismissExternalError={() => setError(null)}
				textareaLabel="First message"
				value={draft}
				onValueChange={setDraft}
				fillRequest={{ nonce: focusNonce }}
			/>
		</div>
	)
}
