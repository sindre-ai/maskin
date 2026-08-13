import { Button } from '@/components/ui/button'

export interface LoopPatchRow {
	label: string
	before: string
	after: string
}

export interface LoopPatch {
	title: string
	rows: LoopPatchRow[]
	note?: string
}

/**
 * The "PROPOSED EDIT" card from the HITL mockup, rendered on loop detail for a
 * pending plain-language edit. Controlled: it renders whatever patch it is
 * handed and never mutates anything on its own — "Leave it" calls `onDismiss` (a
 * no-op for state) and "Make the change" calls `onApply`, which the caller wires
 * to the real loop update path. This is the bet's riskiest assumption: an
 * approved patch round-trips into a live loop without breaking its state.
 */
export function LoopPatchCard({
	patch,
	isApplying = false,
	onApply,
	onDismiss,
}: {
	patch: LoopPatch
	isApplying?: boolean
	onApply: () => void
	onDismiss: () => void
}) {
	return (
		<div className="overflow-hidden rounded-xl border border-accent bg-accent/40">
			<div className="px-4 py-3">
				<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
					<span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-primary">
						Proposed edit
					</span>
					<span className="min-w-0 flex-1 text-[13px] font-bold text-foreground">
						{patch.title}
					</span>
				</div>

				<div className="mt-3 flex flex-wrap gap-2">
					{patch.rows.map((row) => (
						<div
							key={row.label}
							className="flex min-w-[190px] flex-1 flex-col gap-1 rounded-lg border border-border bg-card px-2.5 py-2"
						>
							<span className="font-mono text-[9px] uppercase tracking-[0.09em] text-muted-foreground">
								{row.label}
							</span>
							<span className="text-[11.5px] text-muted-foreground line-through">{row.before}</span>
							<span className="text-[11.5px] font-semibold text-foreground">{row.after}</span>
						</div>
					))}
				</div>

				{patch.note && (
					<div className="mt-2.5 text-xs leading-relaxed text-muted-foreground">{patch.note}</div>
				)}
			</div>

			<div className="flex items-center gap-2 border-t border-border bg-card px-4 py-2.5">
				<Button size="sm" className="px-4" onClick={onApply} disabled={isApplying}>
					{isApplying ? 'Applying…' : 'Make the change'}
				</Button>
				<Button variant="outline" size="sm" onClick={onDismiss} disabled={isApplying}>
					Leave it
				</Button>
				<span className="ml-auto whitespace-nowrap text-[11px] text-muted-foreground">
					nothing moves until you say so
				</span>
			</div>
		</div>
	)
}
