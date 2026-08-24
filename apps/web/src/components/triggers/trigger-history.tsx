import { RelativeTime } from '@/components/shared/relative-time'
import { useActors } from '@/hooks/use-actors'
import { useEntityEvents } from '@/hooks/use-events'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { cn } from '@/lib/cn'
import { formatEventDescription } from '@maskin/shared'
import { useMemo } from 'react'

const MAX_RUNS = 5
const MAX_CHANGES = 8

/**
 * `RECENT RUNS` + `CHANGES` on trigger detail (mockup 1788–1811). Both read
 * data the workspace already has — sessions dispatched by this trigger, and
 * this trigger's own event log — so neither needs a new endpoint.
 */
export function TriggerHistory({
	workspaceId,
	triggerId,
}: {
	workspaceId: string
	triggerId: string
}) {
	const { data: sessions } = useWorkspaceSessions(workspaceId)
	const { data: events } = useEntityEvents(workspaceId, triggerId)
	const { data: actors } = useActors(workspaceId)

	const actorsById = useMemo(() => {
		const map = new Map<string, { id: string; name: string; type: string }>()
		for (const actor of actors ?? []) map.set(actor.id, actor)
		return map
	}, [actors])

	const runs = useMemo(
		() =>
			[...(sessions ?? [])]
				.filter((s) => s.triggerId === triggerId)
				.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
				.slice(0, MAX_RUNS),
		[sessions, triggerId],
	)

	const changes = useMemo(
		() =>
			[...(events ?? [])]
				.filter((e) => e.entityId === triggerId)
				.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
				.slice(-MAX_CHANGES),
		[events, triggerId],
	)

	return (
		<>
			{runs.length > 0 && (
				<section className="mt-6">
					<h2 className="eyebrow">RECENT RUNS</h2>
					<ul className="mt-3 flex flex-col gap-2">
						{runs.map((run) => (
							<li key={run.id} className="flex items-baseline gap-3">
								<span className="w-[38px] shrink-0 font-mono text-[9.5px] font-semibold tracking-[0.05em] text-muted-foreground">
									{run.createdAt ? <RelativeTime date={run.createdAt} /> : '—'}
								</span>
								<span className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
									{run.currentActivity ?? run.actionPrompt ?? run.status}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}

			{changes.length > 0 && (
				<section className="mt-6">
					<h2 className="eyebrow">CHANGES</h2>
					<ul className="mt-3 flex flex-col gap-2.5">
						{changes.map((event) => {
							const actor = actorsById.get(event.actorId)
							const isHuman = actor?.type === 'human'
							return (
								<li
									key={event.id}
									className={cn('flex', isHuman ? 'justify-end' : 'justify-start')}
								>
									<p
										className={cn(
											'max-w-[85%] rounded-2xl border px-3.5 py-2.5 text-[13px] leading-relaxed',
											isHuman
												? 'border-primary bg-primary text-primary-foreground'
												: 'border-border bg-card text-foreground',
										)}
									>
										{formatEventDescription(event, { actorsById })}
									</p>
								</li>
							)
						})}
					</ul>
				</section>
			)}
		</>
	)
}
