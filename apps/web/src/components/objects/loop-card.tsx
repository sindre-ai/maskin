import { ObjectReference } from '@/components/shared/object-reference'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import type { ObjectResponse } from '@/lib/api'

interface LoopCardProps {
	object: ObjectResponse
	workspaceId: string
}

function readString(metadata: unknown, key: string): string | null {
	if (!metadata || typeof metadata !== 'object') return null
	const value = (metadata as Record<string, unknown>)[key]
	return typeof value === 'string' && value.length > 0 ? value : null
}

export function LoopCard({ object, workspaceId }: LoopCardProps) {
	const floor = readString(object.metadata, 'floor')
	const cadence = readString(object.metadata, 'cadence')
	const sourceBetId = readString(object.metadata, 'source_bet_id')
	const lastBreachAt = readString(object.metadata, 'last_breach_at')

	return (
		<section
			data-testid="loop-card"
			aria-label="Loop"
			className="mb-6 rounded-lg border border-border bg-card p-4 shadow-sm"
		>
			<div className="flex items-start justify-between gap-2">
				<h2 className="min-w-0 flex-1 text-base font-semibold leading-snug text-foreground truncate">
					{object.title || 'Untitled loop'}
				</h2>
				<StatusBadge status={object.status} className="shrink-0" />
			</div>

			<dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
				{floor && (
					<div className="flex flex-col">
						<dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Floor</dt>
						<dd className="mt-0.5 text-sm text-foreground">{floor}</dd>
					</div>
				)}
				{cadence && (
					<div className="flex flex-col">
						<dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Cadence</dt>
						<dd className="mt-0.5 text-sm text-foreground">{cadence}</dd>
					</div>
				)}
				{sourceBetId && (
					<div className="flex flex-col">
						<dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
							Source bet
						</dt>
						<dd className="mt-0.5 text-sm">
							<ObjectReference
								objectId={sourceBetId}
								workspaceId={workspaceId}
								variant="inline"
								showStatus={false}
								showType={false}
							/>
						</dd>
					</div>
				)}
				{lastBreachAt && (
					<div className="flex flex-col">
						<dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
							Last breach
						</dt>
						<dd className="mt-0.5 text-sm text-foreground">
							<RelativeTime date={lastBreachAt} />
						</dd>
					</div>
				)}
			</dl>
		</section>
	)
}
