import type { ObjectResponse } from '@/lib/api'
import type { RelationshipResponse } from '@/lib/api'
import { BetCard } from './bet-card'

export function BetGroup({
	status,
	bets,
	relationships,
	workspaceId,
}: {
	status: string
	bets: ObjectResponse[]
	relationships: RelationshipResponse[]
	workspaceId: string
}) {
	if (bets.length === 0) return null

	return (
		<div className="space-y-3">
			<h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
				{status.replace(/_/g, ' ')}
			</h2>
			<div className="space-y-2">
				{bets.map((bet) => {
					const insightCount = relationships.filter(
						(r) => r.targetId === bet.id && r.type === 'informs',
					).length
					const taskCount = relationships.filter(
						(r) => r.sourceId === bet.id && r.type === 'breaks_into',
					).length

					return (
						<BetCard
							key={bet.id}
							bet={bet}
							workspaceId={workspaceId}
							insightCount={insightCount}
							taskCount={taskCount}
						/>
					)
				})}
			</div>
		</div>
	)
}
