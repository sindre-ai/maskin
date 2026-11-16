import { ActorAvatar } from '@/components/shared/actor-avatar'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { useActiveAgents } from '@/hooks/use-active-agents'
import { useActors } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import {
	useAddConversationParticipants,
	useRemoveConversationParticipant,
} from '@/hooks/use-conversation'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import type { ConversationParticipantResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { Link, useNavigate } from '@tanstack/react-router'
import { Command } from 'cmdk'
import { Link2, Search } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { toast } from 'sonner'

interface ParticipantsPopoverProps {
	workspaceId: string
	conversationId: string
	participants: ConversationParticipantResponse[]
	createdBy: string
	children: ReactNode
}

export function ParticipantsPopover({
	workspaceId,
	conversationId,
	participants,
	createdBy,
	children,
}: ParticipantsPopoverProps) {
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const { data: members } = useWorkspaceMembers(workspaceId)
	const { data: actors } = useActors(workspaceId, { enabled: open })
	const addParticipants = useAddConversationParticipants(conversationId, workspaceId)
	const removeParticipant = useRemoveConversationParticipant(conversationId, workspaceId)
	const navigate = useNavigate()
	// Adding and removing people are writes, a viewer's own exit included.
	const canWrite = useCanWrite()
	const currentActor = getStoredActor()

	const participantIds = useMemo(() => new Set(participants.map((p) => p.actorId)), [participants])
	const roleByActorId = useMemo(() => {
		const map = new Map<string, string>()
		for (const m of members ?? []) map.set(m.actorId, m.role)
		return map
	}, [members])

	// Which agents are working right now, for the sub-line under an agent.
	const { agents: workingAgents } = useActiveAgents(workspaceId)
	const workingById = useMemo(
		() => new Map(workingAgents.map((a) => [a.actorId, a.currentActivity])),
		[workingAgents],
	)

	// Sub-line under each name: the role for a person, Working or Idle for an agent.
	const subLineFor = (actorId: string, actorType: string): string => {
		if (actorId === currentActor?.id) {
			return createdBy === currentActor?.id ? 'You · owner of this chat' : 'You'
		}
		if (actorType === 'agent') {
			if (!workingById.has(actorId)) return 'Idle'
			const activity = workingById.get(actorId)
			return activity ? `Working now · ${activity}` : 'Working now'
		}
		const role = roleByActorId.get(actorId)
		return role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Member'
	}

	// You first, then A to Z, in each group.
	const byYouThenName = (
		a: ConversationParticipantResponse,
		b: ConversationParticipantResponse,
	) => {
		const aYou = a.actorId === currentActor?.id ? 0 : 1
		const bYou = b.actorId === currentActor?.id ? 0 : 1
		return (
			aYou - bYou ||
			a.actorName.localeCompare(b.actorName, undefined, { sensitivity: 'base', numeric: true }) ||
			a.actorId.localeCompare(b.actorId)
		)
	}
	const people = participants.filter((p) => p.actorType !== 'agent').sort(byYouThenName)
	const agentRows = participants.filter((p) => p.actorType === 'agent').sort(byYouThenName)

	const candidates = useMemo(() => {
		const byId = new Map<string, { id: string; name: string; type: string }>()
		for (const m of members ?? []) {
			if (m.type !== 'system' && !participantIds.has(m.actorId))
				byId.set(m.actorId, { id: m.actorId, name: m.name, type: m.type })
		}
		for (const a of actors ?? []) {
			if (a.type === 'agent' && !participantIds.has(a.id)) {
				byId.set(a.id, { id: a.id, name: a.name, type: a.type })
			}
		}
		const needle = query.trim().toLowerCase()
		const all = Array.from(byId.values())
		return needle ? all.filter((c) => c.name.toLowerCase().includes(needle)) : all
	}, [members, actors, participantIds, query])

	const handleAdd = (actorId: string) => {
		addParticipants.mutate([actorId])
	}

	const handleRemove = (actorId: string) => {
		removeParticipant.mutate(actorId, {
			onSuccess: () => {
				if (actorId === currentActor?.id) {
					navigate({ to: '/$workspaceId/chats', params: { workspaceId } })
				}
			},
		})
	}

	const handleCopyLink = async () => {
		try {
			await navigator.clipboard.writeText(window.location.href)
			toast.success('Link copied')
		} catch {
			toast.error('Could not copy link')
		}
	}

	return (
		<ResponsivePopover open={open} onOpenChange={setOpen}>
			<ResponsivePopoverTrigger asChild>{children}</ResponsivePopoverTrigger>
			<ResponsivePopoverContent
				align="start"
				className="w-[292px] p-0"
				accessibleTitle="Manage participants"
			>
				<div className="flex max-h-[70vh] flex-col overflow-y-auto">
					{[
						{ label: 'People', rows: people },
						{ label: 'Agents', rows: agentRows },
					]
						.filter((group) => group.rows.length > 0)
						.map((group) => (
							<div key={group.label}>
								<div className="eyebrow px-3 pt-3 pb-1">
									{group.label} · {group.rows.length}
								</div>
								<ul className="flex flex-col gap-0.5 px-1 pb-1">
									{group.rows.map((p) => {
										const isMe = p.actorId === currentActor?.id
										// Mirrors the backend rule: a participant may leave themself,
										// and the conversation creator may remove anyone else.
										const canRemove = isMe || createdBy === currentActor?.id
										return (
											<li
												key={p.actorId}
												className="flex items-center gap-2.5 rounded-lg px-2 py-1.5"
											>
												{p.actorType === 'agent' ? (
													<Link
														to="/$workspaceId/agents/$agentId"
														params={{ workspaceId, agentId: p.actorId }}
														onClick={() => setOpen(false)}
														className="-m-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-md p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
													>
														<ActorAvatar
															id={p.actorId}
															name={p.actorName}
															type={p.actorType}
															size="md"
														/>
														<span className="min-w-0 flex-1">
															<span className="block truncate text-[13px] font-semibold">
																{p.actorName}
															</span>
															<span className="block truncate text-[11px] text-muted-foreground">
																{subLineFor(p.actorId, p.actorType)}
															</span>
														</span>
													</Link>
												) : (
													<>
														<ActorAvatar
															id={p.actorId}
															name={p.actorName}
															type={p.actorType}
															size="md"
														/>
														<span className="min-w-0 flex-1">
															<span className="block truncate text-[13px] font-semibold">
																{p.actorName}
															</span>
															<span className="block truncate text-[11px] text-muted-foreground">
																{subLineFor(p.actorId, p.actorType)}
															</span>
														</span>
													</>
												)}
												{canRemove ? (
													<ViewerTooltip>
														<button
															type="button"
															onClick={() => handleRemove(p.actorId)}
															disabled={!canWrite}
															aria-label={isMe ? 'Leave chat' : `Remove ${p.actorName}`}
															className={cn(
																'inline-flex shrink-0 items-center rounded-md px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:hover:bg-transparent max-md:min-h-11',
																isMe ? 'font-semibold text-foreground' : 'text-muted-foreground',
															)}
														>
															{isMe ? 'Leave' : 'Remove'}
														</button>
													</ViewerTooltip>
												) : null}
											</li>
										)
									})}
								</ul>
							</div>
						))}
					<Command
						shouldFilter={false}
						className="mt-1 flex min-h-0 flex-col border-t border-border pt-2"
					>
						<ViewerTooltip className="flex flex-col">
							<div className="relative mx-2 mb-1">
								<Search
									size={14}
									className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
									aria-hidden
								/>
								<Command.Input
									value={query}
									onValueChange={setQuery}
									placeholder="Add a person or an agent"
									aria-label="Add a person or an agent"
									disabled={!canWrite}
									className="w-full rounded-lg border border-border bg-transparent py-1.5 pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50 max-md:min-h-11"
								/>
							</div>
						</ViewerTooltip>
						<Command.List className="max-h-48 overflow-auto px-1 pb-2">
							{candidates.length === 0 ? (
								<div className="px-2 py-3 text-sm text-muted-foreground">No matches.</div>
							) : (
								candidates.map((c) => (
									<Command.Item
										key={c.id}
										value={c.id}
										onSelect={() => handleAdd(c.id)}
										disabled={!canWrite}
										className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
									>
										<ActorAvatar id={c.id} name={c.name} type={c.type} size="md" />
										<span className="min-w-0 flex-1">
											<span className="block truncate text-[12.5px] font-semibold">{c.name}</span>
											<span className="block truncate text-[10.5px] text-muted-foreground">
												{subLineFor(c.id, c.type)}
											</span>
										</span>
									</Command.Item>
								))
							)}
						</Command.List>
					</Command>
					<div className="border-t border-border px-1 pt-1.5">
						<button
							type="button"
							onClick={() => void handleCopyLink()}
							className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-foreground hover:bg-accent"
						>
							<Link2 size={14} className="shrink-0 text-muted-foreground" aria-hidden />
							Copy link to this chat
						</button>
						{/* No "invite by email" row: there is no invite endpoint, so the
						    only thing it could do is hand the URL to a mail client — and a
						    recipient outside the workspace cannot open that link. Offering
						    it promises access the backend does not grant. Restore this once
						    a real invite flow exists. */}
						<p className="px-2.5 pt-1 pb-2.5 text-[10.5px] leading-relaxed text-muted-foreground">
							People see the whole thread. Agents you add start working from it.
						</p>
					</div>
				</div>
			</ResponsivePopoverContent>
		</ResponsivePopover>
	)
}
