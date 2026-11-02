import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Skeleton } from '@/components/shared/loading-skeleton'
import {
	type WorkspaceModelUsage,
	type WorkspaceUsageRow,
	useWorkspaceModelUsage,
} from '@/hooks/use-workspace-model-usage'
import { cn } from '@/lib/cn'

/**
 * Model usage for the billing page (mockup 2803–2813 and 2841–2858).
 *
 * Every number here comes from `GET /api/sessions/usage`, which sums the cost
 * each completed session actually reported. The endpoint is per-actor, so the
 * workspace figure is the sum across the workspace's agents — nothing is
 * estimated, and no allowance/quota is implied. The mockup's two-segment meter
 * needs an "included usage" denominator that no API returns, so this renders
 * the figure without a meter rather than inventing the ceiling.
 */

const usdFormat = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
})

const compactTokens = new Intl.NumberFormat('en-US', {
	notation: 'compact',
	maximumFractionDigits: 1,
})

const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })

export function formatUsd(amount: number): string {
	return usdFormat.format(amount)
}

/**
 * Says plainly that a figure is short. A failed usage query contributes nothing
 * to the sum, so the total renders *lower* than reality — presenting it bare
 * would be an affirmative false claim about money.
 */
function IncompleteUsageNotice({ usage }: { usage: WorkspaceModelUsage }) {
	if (usage.failedAgentCount === 0) return null
	const n = usage.failedAgentCount
	return (
		<output className="block text-xs text-muted-foreground">
			{usage.isError
				? "Couldn't load model usage. No figure is shown because none is known."
				: `Couldn't load usage for ${n} agent${n === 1 ? '' : 's'} — the figures below are incomplete.`}
		</output>
	)
}

/**
 * The headline figure inside the plan banner (mockup 2803–2813) — total, period
 * and reset date. No meter: the "of $X included" denominator has no API field.
 */
export function BillingUsageSummary({ usage }: { usage: WorkspaceModelUsage }) {
	if (usage.isLoading) {
		return <Skeleton className="h-12 w-48" />
	}

	return (
		<div>
			{usage.isError ? (
				<p className="text-xs text-muted-foreground">Model usage is unavailable right now.</p>
			) : usage.hasUsage ? (
				<>
					<p className="text-[27px] font-bold tabular-nums leading-tight tracking-tight text-foreground">
						{formatUsd(usage.totalCostUsd)}
					</p>
					<p className="text-[13px] text-muted-foreground">Model usage this month</p>
				</>
			) : (
				<p className="text-xs text-muted-foreground">No model usage recorded this month yet.</p>
			)}
			<IncompleteUsageNotice usage={usage} />
		</div>
	)
}

/** "since 1 Oct · resets 1 Nov" — the billing period the usage figures cover. */
export function billingPeriodLabel(usage: WorkspaceModelUsage): string {
	return `since ${DAY_FORMAT.format(usage.periodStart)} · resets ${DAY_FORMAT.format(usage.resetsAt)}`
}

/**
 * "Usage details" list (mockup 2841–2858, v3 3l "By agent") — one row per agent
 * that ran this month, its share of the total, and the workspace total. The
 * mockup's usage-limit control below the rows has no endpoint to write to, so
 * it is not rendered.
 */
export function BillingUsageDetails({ usage }: { usage: WorkspaceModelUsage }) {
	const summary = usage.isLoading
		? 'loading…'
		: usage.isError
			? 'usage unavailable'
			: usage.hasUsage
				? `${usage.rows.length} agent${usage.rows.length === 1 ? '' : 's'} · ${usage.totalSessions} session${
						usage.totalSessions === 1 ? '' : 's'
					}`
				: 'no agent sessions this month'

	return (
		<section aria-labelledby="billing-usage-heading" className="border-t border-border pt-4">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<h2 id="billing-usage-heading" className="text-[13px] font-semibold text-foreground">
					Usage details
				</h2>
				{/* The split is by agent only: usage is recorded per actor, so there is no
				    per-model or per-flow breakdown to show yet. */}
				<span className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
					By agent
				</span>
				<span className="text-xs text-muted-foreground">{summary}</span>
			</div>
			<div className="pt-4">
				<div className="pb-3 empty:hidden">
					<IncompleteUsageNotice usage={usage} />
				</div>
				{usage.hasUsage ? (
					<div className="rounded-xl border border-border px-4">
						{usage.rows.map((row) => (
							<UsageRow key={row.id} row={row} total={usage.totalCostUsd} />
						))}
						<div className="flex items-center gap-3 py-3">
							<span className="min-w-0 flex-1 text-xs text-muted-foreground">
								Model usage as agents run · the cost each session reported
							</span>
							<span className="shrink-0 text-[12.5px] font-bold tabular-nums text-foreground">
								{formatUsd(usage.totalCostUsd)}
							</span>
						</div>
					</div>
				) : (
					<p className="rounded-xl border border-border bg-muted/30 px-4 py-4 text-xs text-muted-foreground">
						{usage.isError
							? "Couldn't load model usage, so there is nothing to break down. This is a loading failure, not an absence of usage."
							: 'No agent has finished a session this month, so there is nothing to break down yet.'}
					</p>
				)}
			</div>
		</section>
	)
}

function UsageRow({ row, total }: { row: WorkspaceUsageRow; total: number }) {
	const share = total > 0 ? Math.min(1, row.costUsd / total) : 0
	const pct = Math.round(share * 100)

	return (
		<div className="flex items-start gap-3 border-b border-border py-3 last:border-b-0">
			<ActorAvatar name={row.name} type={row.type} size="md" id={row.id} className="shrink-0" />
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline gap-3">
					<span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
						{row.name}
					</span>
					<span className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">
						{formatUsd(row.costUsd)}
					</span>
				</div>
				<span className="block text-[11px] text-muted-foreground">
					{row.sessions} session{row.sessions === 1 ? '' : 's'} · {compactTokens.format(row.tokens)}{' '}
					tokens
				</span>
				<span
					className="mt-1.5 block h-1 overflow-hidden rounded-full bg-muted"
					title={`${pct}% of this month's model usage`}
				>
					<span
						aria-hidden
						className="block h-full rounded-full bg-primary"
						style={{ width: `${pct}%` }}
					/>
				</span>
			</div>
		</div>
	)
}

// Re-exported so the billing page can pull the view and its data hook from one
// module; the hook itself lives in hooks/ per the project convention.
export { useWorkspaceModelUsage }
export type { WorkspaceModelUsage, WorkspaceUsageRow }
