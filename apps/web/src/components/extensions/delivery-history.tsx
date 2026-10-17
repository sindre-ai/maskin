import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { Badge } from '@/components/ui/badge'
import { useExtensionDeliveries } from '@/hooks/use-extensions'

/**
 * Last 14 days of committed deliveries, read from the idempotency ledger.
 * Failed deliveries (bad signature, bad JSON) write no row, so there is nothing
 * to list for them: the only result a row can have is Committed.
 */
export function DeliveryHistory({
	workspaceId,
	extensionId,
	waiting,
	vendorName,
}: { workspaceId: string; extensionId: string; waiting: boolean; vendorName: string }) {
	const { data, isLoading, isError } = useExtensionDeliveries(workspaceId, extensionId, waiting)

	return (
		<section
			className="rounded-xl border border-border bg-card p-4"
			aria-labelledby="deliveries-heading"
		>
			<h2 id="deliveries-heading" className="text-[13px] font-bold">
				Recent deliveries
			</h2>
			<p className="text-xs text-muted-foreground">
				Last {data?.windowDays ?? 14} days, {data?.committed ?? 0} committed
			</p>

			<div className="mt-3">
				{isLoading ? (
					<ListSkeleton rows={3} />
				) : isError ? (
					<p className="text-xs text-error">Could not load deliveries.</p>
				) : data && data.deliveries.length > 0 ? (
					<table className="w-full text-left text-xs">
						<thead className="text-muted-foreground">
							<tr>
								<th scope="col" className="py-1.5 pr-3 font-medium">
									External ID
								</th>
								<th scope="col" className="py-1.5 pr-3 font-medium">
									Received
								</th>
								<th scope="col" className="py-1.5 font-medium">
									Result
								</th>
							</tr>
						</thead>
						<tbody>
							{data.deliveries.map((d) => (
								<tr key={d.id} className="border-t border-border-subtle">
									<td className="max-w-[12rem] truncate py-2 pr-3 font-mono sm:max-w-none">
										{d.externalId}
									</td>
									<td className="py-2 pr-3 text-muted-foreground">
										<RelativeTime date={d.receivedAt} />
									</td>
									<td className="py-2">
										<Badge variant="secondary">Committed</Badge>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				) : (
					<p className="text-xs text-muted-foreground">
						No deliveries yet. Trigger an event in {vendorName} to see your first webhook arrive
						here.
					</p>
				)}
			</div>

			<p className="mt-3 text-[11px] text-muted-foreground">
				Older deliveries are pruned after 14 days. This window is our idempotency ledger, not a
				durable log.
			</p>
		</section>
	)
}
