import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useActors } from '@/hooks/use-actors'
import {
	useAssignActor,
	useDeleteRelationship,
	useObjectRelationships,
	useWatchObject,
} from '@/hooks/use-relationships'
import { Command } from 'cmdk'
import { Eye, UserPlus, X } from 'lucide-react'

type Mode = 'assign' | 'watch'

interface ParticipantsBarProps {
	workspaceId: string
	objectId: string
	assignees: string[]
	watchers: string[]
}

export function ParticipantsBar({
	workspaceId,
	objectId,
	assignees,
	watchers,
}: ParticipantsBarProps) {
	const { data: actors } = useActors(workspaceId)
	const { data: relationships } = useObjectRelationships(workspaceId, objectId)
	const assign = useAssignActor(workspaceId, objectId)
	const watch = useWatchObject(workspaceId, objectId)
	const deleteRel = useDeleteRelationship(workspaceId, objectId)

	const findEdge = (actorId: string, type: 'assigned_to' | 'watches') =>
		relationships?.asSource.find(
			(r) => r.targetId === actorId && r.targetType === 'actor' && r.type === type,
		)

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Group
				label="Assignees"
				ids={assignees}
				actors={actors ?? []}
				onRemove={(actorId) => {
					const edge = findEdge(actorId, 'assigned_to')
					if (edge) deleteRel.mutate(edge.id)
				}}
			/>
			<AddParticipantButton
				mode="assign"
				assignees={assignees}
				watchers={watchers}
				actors={actors ?? []}
				onPick={(actorId) => assign.mutate(actorId)}
			/>

			<span className="h-4 w-px bg-border" />

			<Group
				label="Watching"
				ids={watchers}
				actors={actors ?? []}
				onRemove={(actorId) => {
					const edge = findEdge(actorId, 'watches')
					if (edge) deleteRel.mutate(edge.id)
				}}
			/>
			<AddParticipantButton
				mode="watch"
				assignees={assignees}
				watchers={watchers}
				actors={actors ?? []}
				onPick={(actorId) => watch.mutate(actorId)}
			/>
		</div>
	)
}

function Group({
	label,
	ids,
	actors,
	onRemove,
}: {
	label: string
	ids: string[]
	actors: { id: string; name: string; type: string }[]
	onRemove: (actorId: string) => void
}) {
	if (ids.length === 0) {
		return <span className="text-[11px] text-muted-foreground">{label}: —</span>
	}
	return (
		<div className="flex items-center gap-1.5">
			<span className="text-[11px] text-muted-foreground">{label}:</span>
			<div className="flex items-center gap-1">
				{ids.map((id) => {
					const actor = actors.find((a) => a.id === id)
					return (
						<span
							key={id}
							className="group inline-flex items-center gap-1 rounded-full bg-muted/60 py-0.5 pl-0.5 pr-2 text-[11px]"
						>
							<ActorAvatar name={actor?.name ?? 'Unknown'} type={actor?.type ?? 'human'} />
							<span className="text-foreground">{actor?.name ?? 'Unknown'}</span>
							<button
								type="button"
								className="ml-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
								onClick={() => onRemove(id)}
								aria-label={`Remove ${actor?.name ?? 'participant'}`}
							>
								<X size={11} />
							</button>
						</span>
					)
				})}
			</div>
		</div>
	)
}

function AddParticipantButton({
	mode,
	assignees,
	watchers,
	actors,
	onPick,
}: {
	mode: Mode
	assignees: string[]
	watchers: string[]
	actors: { id: string; name: string; type: string }[]
	onPick: (actorId: string) => void
}) {
	const excluded = new Set(mode === 'assign' ? assignees : watchers)
	const candidates = actors.filter((a) => !excluded.has(a.id))

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
				>
					{mode === 'assign' ? <UserPlus size={12} /> : <Eye size={12} />}
					{mode === 'assign' ? 'Assign' : 'Watch'}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-64 p-0">
				<Command className="flex flex-col">
					<Command.Input
						placeholder={mode === 'assign' ? 'Assign to…' : 'Add watcher…'}
						className="h-9 border-b border-border bg-transparent px-3 text-sm outline-none"
					/>
					<Command.List className="max-h-64 overflow-y-auto p-1">
						<Command.Empty className="p-3 text-center text-xs text-muted-foreground">
							No one to add.
						</Command.Empty>
						{candidates.map((a) => (
							<Command.Item
								key={a.id}
								value={`${a.name} ${a.type}`}
								onSelect={() => onPick(a.id)}
								className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm aria-selected:bg-muted"
							>
								<ActorAvatar name={a.name} type={a.type} />
								<span className="flex-1 truncate">{a.name}</span>
								<span className="text-[10px] text-muted-foreground capitalize">{a.type}</span>
							</Command.Item>
						))}
					</Command.List>
				</Command>
			</PopoverContent>
		</Popover>
	)
}
