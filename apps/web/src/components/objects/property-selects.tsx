import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import type { MemberResponse } from '@/lib/api'
import { User } from 'lucide-react'
import { ActorAvatar } from '../shared/actor-avatar'

export function StatusSelect({
	current,
	options,
	onChange,
}: {
	current: string
	options: string[]
	onChange: (status: string) => void
}) {
	return (
		<Select value={current} onValueChange={onChange}>
			<SelectTrigger>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((status) => (
					<SelectItem key={status} value={status}>
						{status.replace(/_/g, ' ')}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

const UNASSIGNED_OWNER = '__none__'

export function OwnerSelect({
	members,
	currentOwnerId,
	onChange,
	// Sidebar usage already renders a "driver" label to the left of the
	// trigger (CorePropertyRow) — repeating the icon + "Driver:" text there
	// just pushes the trigger wide enough to force horizontal scroll.
	compact = false,
}: {
	members: MemberResponse[]
	currentOwnerId: string | null
	onChange: (owner: string | null) => void
	compact?: boolean
}) {
	const current = members.find((m) => m.actorId === currentOwnerId)

	const handleChange = (value: string) => {
		onChange(value === UNASSIGNED_OWNER ? null : value)
	}

	return (
		<Select value={currentOwnerId ?? UNASSIGNED_OWNER} onValueChange={handleChange}>
			<SelectTrigger>
				<SelectValue>
					{current ? (
						<span className="inline-flex items-center gap-1.5">
							{!compact && current.type !== 'agent' && (
								<User className="size-3 text-amber-600 shrink-0" />
							)}
							{!compact && <span className="text-muted-foreground text-[11px]">Driver:</span>}
							<ActorAvatar name={current.name} type={current.type} size="sm" />
							{current.name}
						</span>
					) : currentOwnerId ? (
						<span className="italic text-muted-foreground">
							Unknown ({currentOwnerId.slice(0, 8)})
						</span>
					) : (
						<span className="text-muted-foreground">
							{compact ? 'Unassigned' : 'Driver: Unassigned'}
						</span>
					)}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={UNASSIGNED_OWNER}>
					<span className="text-muted-foreground">Unassigned</span>
				</SelectItem>
				{members.map((m) => (
					<SelectItem key={m.actorId} value={m.actorId}>
						<span className="inline-flex items-center gap-1.5">
							<ActorAvatar name={m.name} type={m.type} size="sm" />
							{m.name}
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}
