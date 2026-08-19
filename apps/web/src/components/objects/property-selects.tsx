import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import type { MemberResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getStatusColor } from '@/lib/constants'
import { User } from 'lucide-react'
import { ActorAvatar } from '../shared/actor-avatar'

/** `default` is the plain trigger the properties drawer uses. `chip` is the
 *  document's identity-row reading (mockup 1058–1094): a mono uppercase status
 *  chip and an `[avatar] Driver <Name>` chip. Both keep the shadcn trigger's
 *  own height / border / padding — only the label treatment changes. */
export type PropertySelectVariant = 'default' | 'chip'

export function StatusSelect({
	current,
	options,
	onChange,
	variant = 'default',
	// Opt-in flag: only the hero copy carries the anchor. The sticky nav's chip
	// smooth-scrolls to the hero and focuses this trigger — a menu copy would
	// steal that focus target and break the "click chip → land on hero" path.
	heroAnchor = false,
}: {
	current: string
	options: string[]
	onChange: (status: string) => void
	variant?: PropertySelectVariant
	heroAnchor?: boolean
}) {
	const isChip = variant === 'chip'
	const dot = getStatusColor(current)
	return (
		<Select value={current} onValueChange={onChange}>
			<SelectTrigger
				size={isChip ? 'chip' : 'default'}
				// The status chip is the one chip that keeps a resting hairline
				// (mockup `odSkBc`); the driver beside it takes one only on hover.
				className={cn(isChip && 'rounded-md border-border py-[3px] pl-[7px] pr-1.5')}
				data-hero-status-trigger={heroAnchor ? '' : undefined}
				title={isChip ? 'Change status' : undefined}
			>
				{isChip ? (
					<span
						className={cn(
							'font-mono text-[9.5px] font-bold uppercase leading-none tracking-[0.09em]',
							dot.text,
						)}
					>
						{current.replace(/_/g, ' ')}
					</span>
				) : (
					<SelectValue />
				)}
			</SelectTrigger>
			<SelectContent>
				<SelectGroup>
					<SelectLabel className="eyebrow">Set status</SelectLabel>
					{options.map((status) => (
						<SelectItem key={status} value={status}>
							{status.replace(/_/g, ' ')}
						</SelectItem>
					))}
				</SelectGroup>
			</SelectContent>
		</Select>
	)
}

const UNASSIGNED_OWNER = '__none__'

export function OwnerSelect({
	members,
	currentOwnerId,
	onChange,
	variant = 'default',
	// Sidebar usage already renders a "driver" label to the left of the
	// trigger (CorePropertyRow) — repeating the icon + "Driver:" text there
	// just pushes the trigger wide enough to force horizontal scroll.
	compact = false,
}: {
	members: MemberResponse[]
	currentOwnerId: string | null
	onChange: (owner: string | null) => void
	variant?: PropertySelectVariant
	compact?: boolean
}) {
	const current = members.find((m) => m.actorId === currentOwnerId)
	const isChip = variant === 'chip'

	const handleChange = (value: string) => {
		onChange(value === UNASSIGNED_OWNER ? null : value)
	}

	return (
		<Select value={currentOwnerId ?? UNASSIGNED_OWNER} onValueChange={handleChange}>
			<SelectTrigger
				size={isChip ? 'chip' : 'default'}
				className={cn(isChip && 'gap-1.5 pl-1.5 pr-2')}
				title={isChip ? 'Change who drives this' : undefined}
			>
				<SelectValue>
					{current ? (
						<span className="inline-flex items-center gap-1.5">
							{!compact && !isChip && current.type !== 'agent' && (
								<User className="size-3 text-amber-600 shrink-0" />
							)}
							<ActorAvatar
								name={current.name}
								type={current.type}
								size="sm"
								className={cn(isChip && 'size-[15px] text-[8px]')}
							/>
							{!compact && (
								<span className="text-muted-foreground">{isChip ? 'Driver' : 'Driver:'}</span>
							)}
							<span className={cn(isChip && 'font-semibold text-secondary-foreground')}>
								{current.name}
							</span>
						</span>
					) : currentOwnerId ? (
						<span className="italic text-muted-foreground">
							Unknown ({currentOwnerId.slice(0, 8)})
						</span>
					) : isChip ? (
						<span className="inline-flex items-center gap-1.5">
							<span className="text-muted-foreground">Driver</span>
							<span className="font-semibold text-secondary-foreground">Unassigned</span>
						</span>
					) : (
						<span className="text-muted-foreground">
							{compact ? 'Unassigned' : 'Driver: Unassigned'}
						</span>
					)}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				<SelectGroup>
					<SelectLabel className="eyebrow">Who drives this</SelectLabel>
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
				</SelectGroup>
			</SelectContent>
		</Select>
	)
}
