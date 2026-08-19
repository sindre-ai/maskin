import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { LoopSummary } from '@/lib/api'
import { cn } from '@/lib/cn'
import { LOOP_STATUSES } from '@maskin/shared'
import { ChevronDown } from 'lucide-react'
import { LOOP_PILL_STYLES } from './loop-pill'

/**
 * The `LOOP  RUNNING ⌄` eyebrow at the top of loop detail (mockup 1826–1846).
 * The pill reads the composite `pill` (so a loop waiting on the operator says
 * so), while the menu sets the stored `status` — the autonomy ladder — which is
 * the only part a human actually chooses.
 */
export function LoopStatusMenu({
	loop,
	onChange,
	disabled,
}: {
	loop: LoopSummary
	onChange: (status: LoopSummary['status']) => void
	disabled?: boolean
}) {
	const pill = LOOP_PILL_STYLES[loop.pill]

	return (
		<div className="mb-2.5 flex items-center gap-2">
			<span className="eyebrow">Loop</span>
			<DropdownMenu>
				<DropdownMenuTrigger
					disabled={disabled}
					aria-label="Change status"
					className={cn(
						'inline-flex items-center gap-1.5 rounded-md px-1.5 py-[3px] font-mono text-[9.5px] font-bold uppercase tracking-[0.09em] transition-colors hover:bg-muted disabled:opacity-50',
						pill.text,
					)}
				>
					{pill.label}
					<ChevronDown size={9} className="text-border-strong" aria-hidden="true" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-[196px]">
					<DropdownMenuLabel className="eyebrow">Set status</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value={loop.status}
						onValueChange={(value) => onChange(value as LoopSummary['status'])}
					>
						{LOOP_STATUSES.map((status) => (
							<DropdownMenuRadioItem key={status} value={status} className="text-[12.5px]">
								<span
									aria-hidden="true"
									className={cn(
										'mr-2 size-[7px] shrink-0 rounded-full',
										LOOP_PILL_STYLES[status].dot,
									)}
								/>
								{LOOP_PILL_STYLES[status].label}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	)
}
