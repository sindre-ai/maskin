import { InThisChatPanel, type Participant } from '@/components/chat/in-this-chat-panel'
import { type ParticipantAvatarSpec, ParticipantStack } from '@/components/chat/participant-stack'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { ChevronLeft, Repeat } from 'lucide-react'

interface LoopContext {
	id: string
	name: string | null
}

interface ChiefOfStaff {
	id: string
	name: string
	/** Short one-line role — appears under the name in the attribution row. */
	roleLine: string
}

interface ConversationHeaderProps {
	workspaceId: string
	title: string
	participants: Participant[]
	availableActors: ActorListItem[]
	onAddParticipant: (actor: ActorListItem) => void
	onRemoveParticipant: (participantId: string) => void
	conversationUrl: string
	/** When set, the CoS attribution row renders below the title and the panel
	 * treats her as the pinned, non-removable default. */
	chiefOfStaff: ChiefOfStaff | null
	/** When set, a compact loop chip renders on the right. */
	loop: LoopContext | null
}

/**
 * Conversation view header. Renders:
 *  - Back control (mobile only — desktop keeps the chat list visible)
 *  - Title
 *  - CoS attribution row (when present) with participant stack + loop chip
 *  - Otherwise the participant stack + loop chip sit on the title row
 */
export function ConversationHeader({
	workspaceId,
	title,
	participants,
	availableActors,
	onAddParticipant,
	onRemoveParticipant,
	conversationUrl,
	chiefOfStaff,
	loop,
}: ConversationHeaderProps) {
	const stackParticipants: ParticipantAvatarSpec[] = participants.map((p) => ({
		id: p.id,
		name: p.name,
		type: p.type,
	}))

	const hasChiefOfStaff = chiefOfStaff !== null

	const stackTrigger = <ParticipantStack participants={stackParticipants} />

	const panel = (
		<InThisChatPanel
			trigger={stackTrigger}
			participants={participants}
			availableActors={availableActors}
			onAddParticipant={onAddParticipant}
			onRemoveParticipant={onRemoveParticipant}
			conversationUrl={conversationUrl}
			hasChiefOfStaff={hasChiefOfStaff}
		/>
	)

	return (
		<header className="border-b border-border bg-background px-4 py-3 md:px-5">
			<div className="flex items-start gap-2">
				<Button
					asChild
					variant="ghost"
					size="icon"
					className="md:hidden -ml-1 h-9 w-9 min-h-[44px] min-w-[44px]"
					aria-label="Back to chats"
				>
					<Link to="/$workspaceId/chats" params={{ workspaceId }}>
						<ChevronLeft size={18} aria-hidden />
					</Link>
				</Button>
				<h1 className="min-w-0 flex-1 truncate text-sm font-semibold leading-snug tracking-tight text-foreground md:text-base">
					{title}
				</h1>
				{!hasChiefOfStaff && (
					<div className="flex flex-none items-center gap-2">
						{panel}
						{loop && <LoopChip name={loop.name ?? 'loop'} />}
					</div>
				)}
			</div>
			{hasChiefOfStaff && (
				<div
					className={cn(
						'mt-2 flex flex-col gap-2 rounded-lg border p-2 sm:flex-row sm:items-center sm:gap-3',
						'border-[color:var(--color-cos-tint-border)] bg-[color:var(--color-cos-tint)]',
					)}
				>
					<ActorAvatar
						name={chiefOfStaff.name}
						type="agent"
						id={chiefOfStaff.id}
						size="md"
						className="flex-none"
					/>
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-foreground">
							<span className="min-w-0 truncate">{chiefOfStaff.name}</span>
							<span className="rounded border border-[color:var(--color-cos-tint-border)] bg-background px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.09em] text-[color:var(--color-cos)]">
								Default agent
							</span>
						</div>
						<span className="block text-[11px] text-muted-foreground">{chiefOfStaff.roleLine}</span>
						<span className="mt-1 inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.09em] text-[color:var(--color-cos)] sm:hidden">
							Chief of Staff · default
						</span>
					</div>
					<div className="flex flex-none items-center gap-2 sm:ml-auto">
						{panel}
						{loop && <LoopChip name={loop.name ?? 'loop'} />}
					</div>
				</div>
			)}
		</header>
	)
}

function LoopChip({ name }: { name: string }) {
	return (
		<span className="inline-flex min-h-[44px] items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-text-secondary">
			<Repeat size={11} aria-hidden className="text-success" />
			{name}
		</span>
	)
}
