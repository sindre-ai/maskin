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
	// Opt-in flag: only the hero copy carries the anchor. The sticky nav's chip
	// smooth-scrolls to the hero and focuses this trigger — a menu copy would
	// steal that focus target and break the "click chip → land on hero" path.
	heroAnchor = false,
}: {
	current: string
	options: string[]
	onChange: (status: string) => void
	heroAnchor?: boolean
}) {
	return (
		<Select value={current} onValueChange={onChange}>
			<SelectTrigger data-hero-status-trigger={heroAnchor ? '' : undefined}>
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
}: {
	members: MemberResponse[]
	currentOwnerId: string | null
	onChange: (owner: string | null) => void
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
							{current.type !== 'agent' && <User className="size-3 text-amber-600 shrink-0" />}
							<span className="text-muted-foreground text-[11px]">Driver:</span>
							<ActorAvatar name={current.name} type={current.type} size="sm" />
							{current.name}
						</span>
					) : currentOwnerId ? (
						<span className="italic text-muted-foreground">
							Unknown ({currentOwnerId.slice(0, 8)})
						</span>
					) : (
						<span className="text-muted-foreground">Driver: Unassigned</span>
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
