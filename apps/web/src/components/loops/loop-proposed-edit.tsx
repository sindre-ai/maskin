import { Button } from '@/components/ui/button'
import { type LoopPlan, describeLoopPlan, loopPlanSchema } from '@/lib/loop-plan'

export interface PlanDiffRow {
	label: string
	before: string
	after: string
}

/** Parse the plan snapshot `/loops/new` writes to `metadata.plan`. Returns null
 *  for loops that carry none (marketplace installs, MCP-created loops), which
 *  is the signal to fall back to the chat hand-off.
 *
 *  `metadata` is agent-writable, so a stored plan is untrusted input: a
 *  structurally-invalid snapshot must read as "no plan" rather than reach the
 *  consumers, which dereference `triggers` / `agents` / `stateChain` directly. */
export function readStoredPlan(
	metadata: Record<string, unknown> | null | undefined,
): LoopPlan | null {
	const raw = metadata?.plan
	if (typeof raw !== 'string') return null
	try {
		const result = loopPlanSchema.safeParse(JSON.parse(raw))
		return result.success ? result.data : null
	} catch {
		return null
	}
}

const NONE = 'nothing'

function planFields(plan: LoopPlan): Record<string, string> {
	const primary = plan.objectTypes[0]
	return {
		'OBJECT TYPE': primary?.name ?? NONE,
		STATES: primary?.stateChain?.join(' → ') || NONE,
		TRIGGERS: plan.triggers.map((t) => t.whenClause).join(' · ') || NONE,
		AGENTS: plan.agents.map((a) => a.name).join(', ') || NONE,
		'STOPS FOR YOU': plan.stopForOperator ?? 'never',
	}
}

/** Field-by-field diff between the loop's stored plan and the plan re-parsed
 *  from what the operator just said. Only changed fields are returned. */
export function diffLoopPlans(before: LoopPlan, after: LoopPlan): PlanDiffRow[] {
	const b = planFields(before)
	const a = planFields(after)
	const rows: PlanDiffRow[] = []
	for (const label of Object.keys(b)) {
		if (b[label] !== a[label]) rows.push({ label, before: b[label], after: a[label] })
	}
	return rows
}

/**
 * `PROPOSED EDIT` card above the loop composer (mockup 1992–2016). Nothing is
 * written until the operator presses "Make the change" — the whole point of the
 * card is that the loop is read back before it moves.
 */
export function LoopProposedEdit({
	utterance,
	rows,
	nextPlan,
	onApply,
	onDismiss,
	applying,
}: {
	utterance: string
	rows: PlanDiffRow[]
	nextPlan: LoopPlan
	onApply: () => void
	onDismiss: () => void
	applying?: boolean
}) {
	if (rows.length === 0) return null

	return (
		<div className="mb-3 overflow-hidden rounded-2xl border border-brand-subtle-foreground/30 bg-brand-subtle">
			<div className="px-4 pb-3 pt-3.5">
				<div className="flex flex-wrap items-center gap-2.5">
					<span className="eyebrow text-brand-subtle-foreground">PROPOSED EDIT</span>
					<span className="min-w-0 flex-1 text-[13px] font-bold text-foreground">{utterance}</span>
				</div>
				<div className="mt-3 flex flex-wrap gap-2">
					{rows.map((row) => (
						<div
							key={row.label}
							className="flex min-w-[190px] flex-1 flex-col gap-1 rounded-xl border border-border bg-card px-3 py-2.5"
						>
							<span className="eyebrow">{row.label}</span>
							<span className="text-[11.5px] text-muted-foreground line-through">{row.before}</span>
							<span className="text-[11.5px] font-semibold text-foreground">{row.after}</span>
						</div>
					))}
				</div>
				<p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
					{describeLoopPlan(nextPlan)}
				</p>
			</div>
			<div className="flex flex-wrap items-center gap-2 border-t border-brand-subtle-foreground/20 bg-card px-4 py-2.5">
				<Button size="sm" onClick={onApply} disabled={applying}>
					{applying ? 'Applying…' : 'Make the change'}
				</Button>
				<Button size="sm" variant="outline" onClick={onDismiss} disabled={applying}>
					Leave it
				</Button>
				<span className="ml-auto text-[11px] text-muted-foreground">
					nothing moves until you say so
				</span>
			</div>
		</div>
	)
}
