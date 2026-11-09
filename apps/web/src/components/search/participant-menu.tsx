import { ActorAvatar } from '@/components/shared/actor-avatar'
import { type PickVia, participantOptionId } from '@/hooks/use-participant-menu'
import { cn } from '@/lib/cn'
import type { ParticipantOption } from '@/lib/search/vocabulary'

interface ParticipantMenuProps {
	rows: ParticipantOption[]
	activeIndex: number
	listboxId: string
	onPick: (option: ParticipantOption, via: PickVia) => void
	className?: string
}

// The @ menu: people and agents, filtered as the words after the @ are typed. Real
// focus stays in the search field (rows keep it with preventDefault on mousedown), so
// the field points at the highlighted row with aria-activedescendant.
export function ParticipantMenu({
	rows,
	activeIndex,
	listboxId,
	onPick,
	className,
}: ParticipantMenuProps) {
	return (
		<div
			className={cn(
				'overflow-hidden rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg',
				className,
			)}
		>
			<p className="eyebrow px-2 pb-1 pt-0.5">Only chats with</p>
			{/* biome-ignore lint/a11y/useFocusableInteractive: focus stays in the search field, the listbox is never tabbed to */}
			<div
				id={listboxId}
				// biome-ignore lint/a11y/useSemanticElements: an ARIA listbox the search field controls (aria-activedescendant); <select> is for form values
				role="listbox"
				aria-label="People and agents"
				className="max-h-[280px] overflow-y-auto"
			>
				{rows.map((option, index) => (
					// biome-ignore lint/a11y/useKeyWithClickEvents: the search field handles the keys; rows are pointer targets
					// biome-ignore lint/a11y/useFocusableInteractive: focus stays in the search field, options are never tabbed to
					<div
						key={option.id}
						id={participantOptionId(listboxId, option.id)}
						// biome-ignore lint/a11y/useSemanticElements: option of the listbox above
						role="option"
						aria-selected={index === activeIndex}
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => onPick(option, 'click')}
						className={cn(
							'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] max-[1024.02px]:min-h-11',
							index === activeIndex ? 'bg-accent' : 'hover:bg-accent',
						)}
					>
						<ActorAvatar id={option.id} name={option.name} type={option.type} size="sm" />
						<span className="min-w-0 flex-1 truncate font-medium text-foreground">
							{option.name}
						</span>
						<span className="shrink-0 text-[11.5px] text-muted-foreground">
							{option.type === 'agent' ? 'Agent' : 'Person'}
						</span>
					</div>
				))}
			</div>
		</div>
	)
}
