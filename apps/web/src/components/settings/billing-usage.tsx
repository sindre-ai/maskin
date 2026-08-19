import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
	type WorkspaceModelUsage,
	type WorkspaceUsageRow,
	useWorkspaceModelUsage,
} from '@/hooks/use-workspace-model-usage'
import { cn } from '@/lib/cn'
import { useState } from 'react'

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
 * One labelled figure in the plan strip (mockup 2853–2867). The strip is three
 * of these in a row; the page owns the first (PLAN) and this file owns the two
 * that come from the usage endpoint.
 */
export function BillingStat({
	label,
	value,
	sub,
}: {
	label: string
	value: React.ReactNode
	sub?: string
}) {
	return (
		<div className="min-w-[130px] flex-1 leading-tight">
			<div className="text-[10.5px] font-bold tracking-[0.07em] text-muted-foreground">{label}</div>
			<div className="mt-1">{value}</div>
			{sub ? <div className="mt-0.5 text-[11.5px] text-muted-foreground">{sub}</div> : null}
		</div>
	)
}

/**
 * The usage half of the plan strip (mockup 2858–2867): what ran this month and
 * when the window turns over.
 *
 * The mockup's third stat is LEFT — included allowance minus spend, with a
 * meter under it. Neither `GET /api/billing` nor the usage endpoint carries an
 * allowance, so there is no denominator to subtract from or fill a meter with.
 * RESETS is the honest stat in that slot: it is the one thing about the period
 * the API does know.
 */
export function BillingUsageSummary({ usage }: { usage: WorkspaceModelUsage }) {
	if (usage.isLoading) {
		return <Skeleton className="h-12 w-64" />
	}

	return (
		<>
			<BillingStat
				label="USED THIS MONTH"
				value={
					usage.hasUsage ? (
						<span className="text-lg font-bold tabular-nums tracking-tight text-foreground">
							{formatUsd(usage.totalCostUsd)}
						</span>
					) : (
						<span className="text-xs text-muted-foreground">
							No model usage recorded this month yet.
						</span>
					)
				}
				sub={usage.hasUsage ? 'billed at cost, no markup' : undefined}
			/>
			<BillingStat
				label="RESETS"
				value={
					<span className="text-lg font-bold tracking-tight text-foreground">
						{DAY_FORMAT.format(usage.resetsAt)}
					</span>
				}
				sub={`since ${DAY_FORMAT.format(usage.periodStart)}`}
			/>
		</>
	)
}

/**
 * "Usage details and limits" disclosure (mockup 2841–2858) — one row per agent
 * that ran this month, its share of the total, and the workspace total. The
 * mockup's usage-limit control below the rows has no endpoint to write to, so
 * it is not rendered.
 */
export function BillingUsageDetails({ usage }: { usage: WorkspaceModelUsage }) {
	const [open, setOpen] = useState(false)

	const summary = usage.isLoading
		? 'loading…'
		: usage.hasUsage
			? `${usage.rows.length} agent${usage.rows.length === 1 ? '' : 's'} · ${usage.totalSessions} session${
					usage.totalSessions === 1 ? '' : 's'
				}`
			: 'no agent sessions this month'

	return (
		<Collapsible open={open} onOpenChange={setOpen} className="border-t border-border pt-4">
			<CollapsibleTrigger className="flex w-full items-center gap-3 text-left transition-opacity hover:opacity-70">
				<span className="min-w-0 flex-1">
					<span className="block text-[12.5px] font-semibold text-foreground">Usage details</span>
					<span className="block text-xs text-muted-foreground">{summary}</span>
				</span>
				<span className="shrink-0 text-xs font-semibold text-muted-foreground">
					{open ? 'Hide' : 'Show'}
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="pt-4">
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
						No agent has finished a session this month, so there is nothing to break down yet.
					</p>
				)}
			</CollapsibleContent>
		</Collapsible>
	)
}

function UsageRow({ row, total }: { row: WorkspaceUsageRow; total: number }) {
	const share = total > 0 ? Math.min(1, row.costUsd / total) : 0
	const pct = Math.round(share * 100)

	return (
		<div className="flex items-center gap-3 border-b border-border py-3 last:border-b-0">
			<ActorAvatar name={row.name} type={row.type} size="md" id={row.id} className="shrink-0" />
			<span className="min-w-0 flex-1">
				<span className="block truncate text-[12.5px] font-semibold text-foreground">
					{row.name}
				</span>
				<span className="block text-[11px] text-muted-foreground">
					{row.sessions} session{row.sessions === 1 ? '' : 's'} · {compactTokens.format(row.tokens)}{' '}
					tokens
				</span>
			</span>
			<span
				className="hidden h-[5px] w-[84px] shrink-0 overflow-hidden rounded-full bg-muted sm:block"
				title={`${pct}% of this month's model usage`}
			>
				<span
					aria-hidden
					className={cn('block h-full rounded-full bg-primary')}
					style={{ width: `${pct}%` }}
				/>
			</span>
			<span className="w-[58px] shrink-0 text-right text-[12.5px] font-semibold tabular-nums text-foreground">
				{formatUsd(row.costUsd)}
			</span>
		</div>
	)
}

// Re-exported so the billing page can pull the view and its data hook from one
// module; the hook itself lives in hooks/ per the project convention.
export { useWorkspaceModelUsage }
export type { WorkspaceModelUsage, WorkspaceUsageRow }
