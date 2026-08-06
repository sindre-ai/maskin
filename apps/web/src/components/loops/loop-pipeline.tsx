import { TypeBadge } from '@/components/shared/type-badge'
import type { ObjectResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getStatusColor } from '@/lib/constants'
import { queryKeys } from '@/lib/query-keys'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

function primaryChildType(childObjects: ObjectResponse[]): string | null {
	const counts = new Map<string, number>()
	for (const child of childObjects) {
		counts.set(child.type, (counts.get(child.type) ?? 0) + 1)
	}
	let best: string | null = null
	let bestCount = 0
	for (const [type, count] of counts) {
		if (count > bestCount) {
			best = type
			bestCount = count
		}
	}
	return best
}

export function LoopPipeline({
	workspaceId,
	loopId,
	childObjects,
}: {
	workspaceId: string
	loopId: string
	childObjects: ObjectResponse[]
}) {
	const primaryType = primaryChildType(childObjects)

	const params = primaryType
		? { type: primaryType, groupBy: 'status', 'metadata.loop_id': loopId }
		: undefined
	const { data, isLoading } = useQuery({
		queryKey: queryKeys.objects.board(workspaceId, params),
		queryFn: () => api.objects.board(workspaceId, params as Record<string, string>),
		enabled: !!params,
	})

	if (!primaryType || childObjects.length === 0) return null
	if (isLoading || !data) return null

	const columns = data.columns.filter((col) => col.total > 0 || col.objects.length > 0)
	if (columns.length === 0) return null

	return (
		<div>
			<h2 className="text-sm font-semibold text-foreground mb-2.5">
				What's moving through the loop
			</h2>
			<div className="flex gap-3 overflow-x-auto pb-1">
				{columns.map((column) => {
					const colors = getStatusColor(column.value)
					return (
						<div
							key={column.id}
							className="flex-1 min-w-[220px] rounded-xl border border-border bg-card p-3"
						>
							<div className="flex items-center gap-2 mb-2.5">
								<span
									className={cn(
										'inline-flex items-center rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide',
										colors.bg,
										colors.text,
									)}
								>
									{column.label.replace(/_/g, ' ')}
								</span>
								<span className="text-[10.5px] text-muted-foreground">{column.total}</span>
							</div>
							{column.objects.length === 0 ? (
								<p className="text-[11.5px] text-muted-foreground">Nothing here</p>
							) : (
								<div className="flex flex-col gap-1.5">
									{column.objects.map((obj) => (
										<Link
											key={obj.id}
											to="/$workspaceId/objects/$objectId"
											params={{ workspaceId, objectId: obj.id }}
											className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5 hover:border-foreground/30 transition-colors min-w-0"
										>
											<TypeBadge type={obj.type} />
											<span className="text-[11.5px] font-medium text-foreground truncate min-w-0">
												{obj.title}
											</span>
										</Link>
									))}
								</div>
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
}
