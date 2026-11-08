import { ActorAvatar } from '@/components/shared/actor-avatar'
import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useActors, useDefaultChatAgent } from '@/hooks/use-actors'
import { useCreateConversation } from '@/hooks/use-conversations'
import { useDocumentTitle } from '@/hooks/use-document-title'
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
import { useWorkspace } from '@/lib/workspace-context'
import { deriveConversationTitle } from '@maskin/shared'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useReducer, useRef, useState } from 'react'
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

function footNote(count: number) {
	if (count > 1)
		return `This starts a group chat with ${count} people and agents. Everyone sees everything.`
	return 'Pick one agent for a direct chat, or several for a group.'
}

function GroupLabel({ children }: { children: string }) {
	return <h2 className="px-1.5 pb-2 text-[13px] font-medium text-muted-foreground">{children}</h2>
}

const ROW = 'flex items-center gap-3 border-t border-border px-1.5 py-3.5 last:border-b'

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

	const toggle = (id: string, on: boolean) => {
		setError(null)
		setPickedIds((prev) =>
			on ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((p) => p !== id),
		)
	}

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault()
		if (createConversation.isPending) return
		if (picked.length === 0) {
			setError('Pick at least one person or agent to start the conversation')
			return
		}
		setError(null)

		const content = draft.trim()
		const metadata: MessageMetadata = {}
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
				...(content ? { initial_message: content } : {}),
				...(content && Object.keys(metadata).length > 0
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
		}
	}

	return (
		<form
			onSubmit={handleSubmit}
			className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-10 md:px-8 lg:px-7"
		>
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

			<section aria-label="To" className="mt-16">
				<GroupLabel>To</GroupLabel>
				<ul className="m-0 flex list-none flex-col p-0">
					{rows.map((r) => {
						const on = pickedIds.includes(r.id)
						return (
							<li key={r.id} className={ROW}>
								<ActorAvatar id={r.id} name={r.name} type={r.type} size="md" />
								<span className="min-w-0 flex-1 truncate text-[14.5px] text-foreground">
									{r.name}
								</span>
								<Switch
									checked={on}
									onCheckedChange={(next) => toggle(r.id, next)}
									aria-label={`Add ${r.name}`}
								/>
							</li>
						)
					})}
				</ul>
			</section>

			{selection.objects.length > 0 || selection.notifications.length > 0 ? (
				<section aria-label="Context" className="mt-16">
					<GroupLabel>Context</GroupLabel>
					<ul className="m-0 flex list-none flex-col p-0">
						{selection.objects.map((o) => (
							<li key={o.id} className={ROW}>
								<span className="min-w-0 flex-1 truncate text-[14.5px] text-foreground">
									{o.title ?? 'Untitled item'}
								</span>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="rounded-full text-muted-foreground"
									onClick={() => dispatchSelection({ type: 'remove_object', id: o.id })}
								>
									Remove
								</Button>
							</li>
						))}
						{selection.notifications.map((n) => (
							<li key={n.id} className={ROW}>
								<span className="min-w-0 flex-1 truncate text-[14.5px] text-foreground">
									{n.title ?? 'Notification'}
								</span>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="rounded-full text-muted-foreground"
									onClick={() => dispatchSelection({ type: 'remove_notification', id: n.id })}
								>
									Remove
								</Button>
							</li>
						))}
					</ul>
				</section>
			) : null}

			<section aria-label="Message" className="mt-16">
				<GroupLabel>Message</GroupLabel>
				<div className={ROW}>
					<label
						htmlFor="new-chat-first-message"
						className="shrink-0 text-[14.5px] text-foreground"
					>
						First message
					</label>
					<Input
						id="new-chat-first-message"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder="What do you need?"
						autoComplete="off"
						className="ml-auto h-9 min-w-0 flex-1 rounded-full border-0 bg-secondary px-4 md:w-75 md:flex-none"
					/>
				</div>
			</section>

			<p className="mt-3 px-1.5 text-[13px] text-muted-foreground">{footNote(picked.length)}</p>
			<FormError error={error ?? undefined} className="px-1.5" />

			<div className="mt-6">
				<Button
					type="submit"
					className="h-10 rounded-full px-5"
					disabled={createConversation.isPending}
				>
					Start chat
				</Button>
			</div>
		</form>
	)
}
