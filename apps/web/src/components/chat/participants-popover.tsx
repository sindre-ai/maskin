import { ActorAvatar } from '@/components/shared/actor-avatar'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { useActors } from '@/hooks/use-actors'
import {
	useAddConversationParticipants,
	useRemoveConversationParticipant,
} from '@/hooks/use-conversation'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import type { ConversationParticipantResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { useNavigate } from '@tanstack/react-router'
import { Command } from 'cmdk'
import { Link2, Mail, UserMinus } from 'lucide-react'
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
	const currentActor = getStoredActor()

	const participantIds = useMemo(() => new Set(participants.map((p) => p.actorId)), [participants])
	const roleByActorId = useMemo(() => {
		const map = new Map<string, string>()
		for (const m of members ?? []) map.set(m.actorId, m.role)
		return map
	}, [members])

	// Sub-line under each name (mockup 585/595). The agent "outcome" line the
	// mockup shows has no field on the actor contract, so agents get the bare
	// word — see the Chats plan's open question #3.
	const subLineFor = (actorId: string, actorType: string): string => {
		if (actorId === currentActor?.id) {
			return createdBy === currentActor?.id ? 'You · owner of this chat' : 'You'
		}
		if (actorType === 'agent') return 'Agent'
		const role = roleByActorId.get(actorId)
		return role ? `Person · ${role}` : 'Person'
	}

	const candidates = useMemo(() => {
		const byId = new Map<string, { id: string; name: string; type: string }>()
		for (const m of members ?? []) {
			if (!participantIds.has(m.actorId))
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

	// No invite endpoint exists — hand the link to the user's mail client so the
	// row does the thing it says rather than opening a dead dialog.
	const handleInvite = () => {
		const subject = encodeURIComponent('Join this Maskin conversation')
		const body = encodeURIComponent(window.location.href)
		window.location.href = `mailto:?subject=${subject}&body=${body}`
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
					<div className="eyebrow px-3 pt-3 pb-1">In this chat</div>
					<ul className="flex flex-col gap-0.5 px-1 pb-2">
						{participants.map((p) => {
							// Mirrors the backend rule: a participant may leave themself,
							// and the conversation creator may remove anyone else.
							const canRemove = p.actorId === currentActor?.id || createdBy === currentActor?.id
							return (
								<li key={p.actorId} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
									<ActorAvatar id={p.actorId} name={p.actorName} type={p.actorType} size="md" />
									<span className="min-w-0 flex-1">
										<span className="block truncate text-[12.5px] font-semibold">
											{p.actorName}
										</span>
										<span className="block truncate text-[10.5px] text-muted-foreground">
											{subLineFor(p.actorId, p.actorType)}
										</span>
									</span>
									{canRemove ? (
										<button
											type="button"
											onClick={() => handleRemove(p.actorId)}
											aria-label={`Remove ${p.actorName}`}
											className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
										>
											<UserMinus size={13} aria-hidden />
										</button>
									) : null}
								</li>
							)
						})}
					</ul>
					<div className="eyebrow border-t border-border px-3 pt-2 pb-1">
						Add someone — person or agent
					</div>
					<Command shouldFilter={false} className="flex min-h-0 flex-col">
						<Command.Input
							value={query}
							onValueChange={setQuery}
							placeholder="Search people and agents…"
							autoFocus
							className="mx-2 mb-1 rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
						/>
						<Command.List className="max-h-48 overflow-auto px-1 pb-2">
							{candidates.length === 0 ? (
								<div className="px-2 py-3 text-sm text-muted-foreground">No matches.</div>
							) : (
								candidates.map((c) => (
									<Command.Item
										key={c.id}
										value={c.id}
										onSelect={() => handleAdd(c.id)}
										className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
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
						<button
							type="button"
							onClick={handleInvite}
							className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-foreground hover:bg-accent"
						>
							<Mail size={14} className="shrink-0 text-muted-foreground" aria-hidden />
							Invite someone by email
						</button>
						<p className="px-2.5 pt-1 pb-2.5 text-[10.5px] leading-relaxed text-muted-foreground">
							People see the whole thread. Agents you add start working from it.
						</p>
					</div>
				</div>
			</ResponsivePopoverContent>
		</ResponsivePopover>
	)
}
