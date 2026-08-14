import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Input } from '@/components/ui/input'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link2, Lock, Mail, Search, X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { toast } from 'sonner'

export interface Participant {
	id: string
	name: string
	type: 'human' | 'agent'
	/** Kebab-cased role slug (e.g. "chief-of-staff"). */
	role?: string | null
	/** One-line role description shown under the name in the panel. */
	roleLine?: string | null
	/** Sub-line for a specialist row (e.g. "Pulled in by Chief of Staff · 1h ago"). */
	pulledInLine?: string | null
	/** When true, the row is pinned at the top with the CoS tint + lock icon. */
	locked?: boolean
	/** Shown next to the current user in the panel — "Owner · you". */
	isSelf?: boolean
}

interface InThisChatPanelProps {
	trigger: ReactNode
	participants: Participant[]
	availableActors: ActorListItem[]
	onAddParticipant: (actor: ActorListItem) => void
	onRemoveParticipant: (participantId: string) => void
	/** Absolute URL of the conversation, used for the "Copy link" affordance. */
	conversationUrl: string
	/** Fires "Everyone talks to Chief of Staff first." vs. the generic copy. */
	hasChiefOfStaff: boolean
}

/**
 * IN THIS CHAT popover. Desktop = right-anchored popover, mobile = bottom
 * sheet via ResponsivePopover. Renders the pinned Chief of Staff row (when
 * present), the current owner, other participants with a remove button, then
 * an add-someone search over people and agents plus copy-link and
 * invite-by-email rows.
 */
export function InThisChatPanel({
	trigger,
	participants,
	availableActors,
	onAddParticipant,
	onRemoveParticipant,
	conversationUrl,
	hasChiefOfStaff,
}: InThisChatPanelProps) {
	const [query, setQuery] = useState('')

	const participantIds = useMemo(() => new Set(participants.map((p) => p.id)), [participants])

	const matches = useMemo(() => {
		const q = query.trim().toLowerCase()
		return availableActors
			.filter((a) => !participantIds.has(a.id))
			.filter((a) => (q.length === 0 ? false : a.name.toLowerCase().includes(q)))
			.slice(0, 8)
	}, [availableActors, participantIds, query])

	const handleCopyLink = async () => {
		try {
			await navigator.clipboard.writeText(conversationUrl)
			toast.success('Link copied')
		} catch {
			toast.error('Could not copy link')
		}
	}

	const inviteHref = `mailto:?subject=${encodeURIComponent('Join this chat')}&body=${encodeURIComponent(conversationUrl)}`

	return (
		<ResponsivePopover>
			<ResponsivePopoverTrigger asChild>{trigger}</ResponsivePopoverTrigger>
			<ResponsivePopoverContent
				align="end"
				sideOffset={6}
				className="w-80 max-w-[92vw] p-2"
				accessibleTitle="In this chat"
			>
				<h2 className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground">
					In this chat
				</h2>
				<ul className="space-y-1" aria-label="Participants">
					{participants.map((p) => (
						<ParticipantRow key={p.id} participant={p} onRemove={onRemoveParticipant} />
					))}
				</ul>
				<div className="my-2 h-px bg-border" />
				<h3 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground">
					Add someone — person or agent
				</h3>
				<div className="relative px-1">
					<Search
						size={14}
						aria-hidden
						className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search people and agents…"
						aria-label="Search people and agents"
						className="h-9 min-h-[44px] pl-8 text-sm"
					/>
				</div>
				{matches.length > 0 && (
					<ul className="mt-1 space-y-0.5" aria-label="Search results">
						{matches.map((actor) => (
							<li key={actor.id}>
								<button
									type="button"
									onClick={() => {
										onAddParticipant(actor)
										setQuery('')
									}}
									className="flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
								>
									<ActorAvatar name={actor.name} type={actor.type} id={actor.id} size="sm" />
									<span className="min-w-0 flex-1 truncate">{actor.name}</span>
									<span className="text-[10px] uppercase tracking-wide text-muted-foreground">
										{actor.type}
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
				<button
					type="button"
					onClick={handleCopyLink}
					className="mt-1 flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
				>
					<Link2 size={14} aria-hidden className="text-muted-foreground" />
					Copy link to this chat
				</button>
				<a
					href={inviteHref}
					className="mt-0.5 flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
				>
					<Mail size={14} aria-hidden className="text-muted-foreground" />
					Invite someone by email
				</a>
				<p className="px-2 pt-2 pb-1 text-xs leading-snug text-muted-foreground">
					{hasChiefOfStaff ? (
						<>
							<span className="font-semibold text-foreground">
								Everyone talks to Chief of Staff first.
							</span>{' '}
							Specialists are pulled in when they&apos;re needed and stay in the thread while
							they&apos;re working.
						</>
					) : (
						<>People see the whole thread. Agents you add start working from it.</>
					)}
				</p>
			</ResponsivePopoverContent>
		</ResponsivePopover>
	)
}

function ParticipantRow({
	participant,
	onRemove,
}: {
	participant: Participant
	onRemove: (id: string) => void
}) {
	const subLine = participant.isSelf
		? 'Owner · you'
		: participant.locked
			? (participant.roleLine ?? 'Routes your ask to the right specialist')
			: (participant.pulledInLine ?? null)

	return (
		<li
			className={cn(
				'flex items-center gap-2 rounded-md px-2 py-1.5',
				participant.locked &&
					'border border-[color:var(--color-cos-tint-border)] bg-[color:var(--color-cos-tint)]',
			)}
		>
			<ActorAvatar name={participant.name} type={participant.type} id={participant.id} size="sm" />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
					<span className="min-w-0 truncate">{participant.name}</span>
					{participant.locked && (
						<span className="rounded border border-[color:var(--color-cos-tint-border)] bg-background px-1 py-px text-[9px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-cos)]">
							Default
						</span>
					)}
				</div>
				{subLine && (
					<span className="block truncate text-[11px] text-muted-foreground">{subLine}</span>
				)}
			</div>
			{participant.locked ? (
				<Lock size={12} aria-label="Can't be removed" className="text-muted-foreground" />
			) : participant.isSelf ? null : (
				<button
					type="button"
					aria-label={`Remove ${participant.name}`}
					onClick={() => onRemove(participant.id)}
					className="inline-flex h-6 w-6 min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<X size={14} aria-hidden />
				</button>
			)}
		</li>
	)
}
