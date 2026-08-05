import { Badge } from '@/components/ui/badge'
import { useUndoKnowledgeWrite } from '@/hooks/use-objects'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import type { EventResponse, MemberResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import {
	DEV_ACTOR_RETRO_KNOWLEDGE_AUTHOR_NAME,
	KNOWLEDGE_WRITE_UNDO_WINDOW_MS,
} from '@maskin/shared'
import { Undo2 } from 'lucide-react'
import { useCallback } from 'react'
import { toast } from 'sonner'

// Rendered next to the timeline description on any Knowledge Author write for
// the first 7 days after the event. Above 7 days, the chip is hidden — the
// server would 410 anyway, and a persistently-visible chip on years-old writes
// would clutter the timeline.
//
// Two visual states: actionable button (workspace human admin/owner) and
// read-only badge (agents, plain members, viewers). Server is the authority
// on the 403 — this gate purely controls the click affordance.

export function canUndoKnowledgeWrite(members: MemberResponse[] | undefined): boolean {
	const currentActorId = getStoredActor()?.id
	if (!currentActorId || !members) return false
	const member = members.find((m) => m.actorId === currentActorId)
	if (!member) return false
	if (member.type === 'agent') return false
	return member.role === 'admin' || member.role === 'owner'
}

export function isKnowledgeAuthorWriteEvent(
	event: EventResponse,
	actor: { type: string; name: string } | undefined,
): boolean {
	if (event.entityType !== 'knowledge') return false
	if (event.action !== 'updated' && event.action !== 'status_changed') return false
	if (!actor || actor.type !== 'agent') return false
	return actor.name === DEV_ACTOR_RETRO_KNOWLEDGE_AUTHOR_NAME
}

export function isUndoWindowOpen(eventCreatedAt: string | null | undefined, now: number): boolean {
	if (!eventCreatedAt) return false
	const created = Date.parse(eventCreatedAt)
	if (!Number.isFinite(created)) return false
	return now - created < KNOWLEDGE_WRITE_UNDO_WINDOW_MS
}

interface UndoWriteChipProps {
	event: EventResponse
	objectId: string
	workspaceId: string
	// Passing an actor down avoids a per-row `useActor` call — activity-item
	// already resolves the actor once and can hand it back.
	actor: { type: string; name: string } | undefined
	// Injectable for tests. Real callers can omit it and get Date.now.
	now?: number
}

export function UndoWriteChip({ event, objectId, workspaceId, actor, now }: UndoWriteChipProps) {
	const { data: members } = useWorkspaceMembers(workspaceId)
	const mutation = useUndoKnowledgeWrite(workspaceId)
	const canUndo = canUndoKnowledgeWrite(members)

	const handleClick = useCallback(() => {
		if (!canUndo || mutation.isPending) return
		mutation.mutate(
			{ id: objectId, eventId: event.id },
			{
				onSuccess: () => toast.success('Write reverted'),
				onError: (err) => toast.error(err instanceof Error ? err.message : 'Undo failed'),
			},
		)
	}, [canUndo, mutation, objectId, event.id])

	if (!isKnowledgeAuthorWriteEvent(event, actor)) return null
	if (!isUndoWindowOpen(event.createdAt, now ?? Date.now())) return null

	const label = 'Undo'
	const chipClass = cn(
		'gap-1 px-1.5 py-0 text-[10px] font-medium',
		'bg-transparent text-muted-foreground hover:bg-secondary/60',
		!canUndo && 'cursor-default hover:bg-transparent',
	)

	const commonProps = {
		'aria-label': canUndo ? 'Undo this Knowledge Author write' : 'Undo (workspace admins only)',
		title: canUndo
			? 'Undo this write (available for 7 days)'
			: 'Only workspace admins/owners can undo writes',
	}

	if (!canUndo) {
		return (
			<Badge variant="outline" className={chipClass} {...commonProps}>
				<Undo2 size={10} aria-hidden="true" />
				{label}
			</Badge>
		)
	}

	return (
		<button
			type="button"
			onClick={handleClick}
			disabled={mutation.isPending}
			className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-full"
			{...commonProps}
		>
			<Badge variant="outline" className={chipClass}>
				<Undo2 size={10} aria-hidden="true" />
				{label}
			</Badge>
		</button>
	)
}
