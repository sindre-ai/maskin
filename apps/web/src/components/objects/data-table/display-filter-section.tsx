import { cn } from '@/lib/cn'
import { useState } from 'react'

/** One selectable value inside a filter section — a status, a driver, a date
 *  bucket, a quick toggle. */
export interface DisplayFilterOption {
	/** Stable within its section; combined with the section id it forms the pin
	 *  token persisted in display settings (`status:define`). */
	id: string
	label: string
	/** Rows this option would match. Drawn only while the option is off — once
	 *  it is on, the list itself is the count. */
	count?: number
	active: boolean
	onToggle: () => void
}

export interface DisplayFilterSectionModel {
	id: string
	label: string
	/** What the section reads as when collapsed — the active value, or the
	 *  neutral word for "not narrowed" ("Any", "All"). */
	summary: string
	options: DisplayFilterOption[]
	/** Whether options in this section can be pinned to the toolbar chip row.
	 *  A section with hundreds of options (drivers in a large workspace) still
	 *  allows it; one whose values are not stable across sessions should not. */
	pinnable?: boolean
}

interface DisplayFilterSectionProps {
	section: DisplayFilterSectionModel
	/** Full pin tokens (`<sectionId>:<optionId>`) currently pinned. */
	pinnedTokens: ReadonlySet<string>
	onTogglePin?: (token: string) => void
}

export function pinToken(sectionId: string, optionId: string): string {
	return `${sectionId}:${optionId}`
}

/**
 * A collapsed `Label … value ▾` row that expands into its options — the
 * Display panel's FILTERS shape (mockup 682–706).
 *
 * Each option shows its count while off and a check while on, plus a Pin
 * control that promotes it to the toolbar's chip row. Pinning is what keeps
 * this panel from having to stay open: the two or three filters an operator
 * actually reaches for end up one click away, and the rest stay folded.
 */
export function DisplayFilterSection({
	section,
	pinnedTokens,
	onTogglePin,
}: DisplayFilterSectionProps) {
	const [expanded, setExpanded] = useState(false)

	return (
		<div>
			<button
				type="button"
				aria-expanded={expanded}
				// Spoken as "Status filter, Any status" rather than letting the caret
				// glyph and the summary run together into the computed name.
				aria-label={`${section.label} filter, ${section.summary}`}
				onClick={() => setExpanded((v) => !v)}
				className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent"
			>
				{section.label}
				<span className="flex-1" />
				<span className="max-w-[9rem] truncate font-semibold text-foreground">
					{section.summary}
				</span>
				<span aria-hidden="true" className="text-[10px] text-muted-foreground/60">
					▾
				</span>
			</button>
			{expanded &&
				section.options.map((option) => {
					const token = pinToken(section.id, option.id)
					const pinned = pinnedTokens.has(token)
					return (
						// Wrapper only — it carries no handler of its own. The option row
						// and the Pin control are siblings because a <button> cannot nest.
						<div
							key={option.id}
							className={cn(
								'flex items-center gap-2 rounded-lg pr-2 transition-colors hover:bg-accent',
								option.active && 'bg-muted',
							)}
						>
							<button
								type="button"
								aria-pressed={option.active}
								onClick={option.onToggle}
								className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-[22px] pr-0 text-left text-xs text-foreground"
							>
								<span className="min-w-0 truncate">{option.label}</span>
								<span className="flex-1" />
								{option.active ? (
									<span aria-hidden="true" className="font-bold text-brand">
										✓
									</span>
								) : (
									option.count !== undefined && (
										<span className="text-[11px] tabular-nums text-muted-foreground/50">
											{option.count}
										</span>
									)
								)}
							</button>
							{section.pinnable !== false && onTogglePin && (
								<button
									type="button"
									aria-pressed={pinned}
									aria-label={`${pinned ? 'Unpin' : 'Pin'} ${option.label}`}
									onClick={() => onTogglePin(token)}
									className={cn(
										'shrink-0 rounded px-1 py-0.5 text-[10.5px] font-semibold transition-colors hover:bg-border hover:text-foreground',
										pinned ? 'text-brand' : 'text-border-strong',
									)}
								>
									{pinned ? 'Unpin' : 'Pin'}
								</button>
							)}
						</div>
					)
				})}
		</div>
	)
}
