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
import { UserMinus } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

interface ParticipantsPopoverProps {
	workspaceId: string
	conversationId: string
	participants: ConversationParticipantResponse[]
	children: ReactNode
}

export function ParticipantsPopover({
	workspaceId,
	conversationId,
	participants,
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

	return (
		<ResponsivePopover open={open} onOpenChange={setOpen}>
			<ResponsivePopoverTrigger asChild>{children}</ResponsivePopoverTrigger>
			<ResponsivePopoverContent
				align="end"
				className="w-80 p-0"
				accessibleTitle="Manage participants"
			>
				<div className="flex max-h-96 flex-col">
					<div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
						In this chat
					</div>
					<ul className="flex flex-col gap-0.5 px-1 pb-2">
						{participants.map((p) => (
							<li key={p.actorId} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm">
								<ActorAvatar id={p.actorId} name={p.actorName} type={p.actorType} size="sm" />
								<span className="min-w-0 flex-1 truncate">{p.actorName}</span>
								<button
									type="button"
									onClick={() => handleRemove(p.actorId)}
									aria-label={`Remove ${p.actorName}`}
									className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
								>
									<UserMinus size={13} aria-hidden />
								</button>
							</li>
						))}
					</ul>
					<div className="border-t border-border px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
						Add someone — person or agent
					</div>
					<Command shouldFilter={false} className="flex min-h-0 flex-1 flex-col">
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
										className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
									>
										<ActorAvatar id={c.id} name={c.name} type={c.type} size="sm" />
										<span className="min-w-0 flex-1 truncate">{c.name}</span>
									</Command.Item>
								))
							)}
						</Command.List>
					</Command>
				</div>
			</ResponsivePopoverContent>
		</ResponsivePopover>
	)
}
