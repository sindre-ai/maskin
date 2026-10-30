import { ActorAvatar } from '@/components/shared/actor-avatar'
import type { ActorListItem, LoopSummary, ObjectResponse, TriggerResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getStatusColor } from '@/lib/constants'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

interface StageColumn {
	value: string
	label: string
	total: number
	objects: ObjectResponse[]
}

function primaryChildType(children: ObjectResponse[]): string | null {
	const counts = new Map<string, number>()
	for (const child of children) {
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

/** Groups this type's objects into ordered status columns — same shape the
 * board endpoint used to return, computed client-side now that loop
 * membership is a relationship rather than a `metadata.loop_id` filter the
 * board's query builder could key off. Column order follows the workspace's
 * configured statuses for the type; any status seen on an object but not in
 * that list is appended (mirrors the board endpoint's own fallback so a
 * custom/unlisted status never gets silently dropped). */
function buildStageColumns(
	primaryObjects: ObjectResponse[],
	configuredStatuses: string[],
): StageColumn[] {
	const byStatus = new Map<string, ObjectResponse[]>()
	for (const obj of primaryObjects) {
		const list = byStatus.get(obj.status) ?? []
		list.push(obj)
		byStatus.set(obj.status, list)
	}
	const order = [...configuredStatuses]
	for (const status of byStatus.keys()) {
		if (!order.includes(status)) order.push(status)
	}
	return order.map((value) => ({
		value,
		label: value,
		total: byStatus.get(value)?.length ?? 0,
		objects: byStatus.get(value) ?? [],
	}))
}

function formatDuration(ms: number | null | undefined): string | null {
	if (!ms || ms <= 0 || !Number.isFinite(ms)) return null
	const days = Math.round(ms / (24 * 60 * 60 * 1000))
	if (days >= 1) return `${days}d`
	const hours = Math.round(ms / (60 * 60 * 1000))
	if (hours >= 1) return `${hours}h`
	return `${Math.round(ms / (60 * 1000))}m`
}

function pillClasses(active: boolean) {
	return cn(
		'inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-[11.5px] font-semibold border transition-colors',
		active
			? 'bg-secondary text-foreground border-border-strong'
			: 'bg-background text-muted-foreground border-border hover:border-border-strong hover:text-foreground',
	)
}

function StepRow({
	workspaceId,
	trigger,
	agent,
	asksYou,
}: {
	workspaceId: string
	trigger: TriggerResponse
	agent: ActorListItem | undefined
	asksYou?: boolean
}) {
	return (
		// With `/triggers` folded into Loops, this row is the only route into a
		// loop-owned trigger's detail page — the second half of the reachability
		// contract the fold-in depends on.
		<Link
			to="/$workspaceId/triggers/$triggerId"
			params={{ workspaceId, triggerId: trigger.id }}
			className="flex items-start gap-2.5 rounded-lg px-1 py-0.5 -mx-1 transition-colors duration-150 hover:bg-muted"
		>
			<ActorAvatar
				id={trigger.targetActorId}
				name={agent?.name ?? 'Unknown agent'}
				type={agent?.type ?? 'agent'}
				className="mt-0.5"
			/>
			<div className="flex-1 min-w-0 break-words text-[12.5px] leading-relaxed">
				<span className="font-semibold text-foreground">{agent?.name ?? 'Unknown agent'}</span>{' '}
				<span className="text-muted-foreground">{trigger.name}</span>
			</div>
			{asksYou && (
				<span className="shrink-0 inline-flex items-center rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-semibold text-accent-foreground mt-0.5">
					asks you
				</span>
			)}
			{!trigger.enabled && (
				<span className="text-[10.5px] font-medium text-muted-foreground shrink-0 mt-0.5">off</span>
			)}
		</Link>
	)
}

export function LoopFlow({
	workspaceId,
	triggers,
	actors,
	childObjects,
	loop,
}: {
	workspaceId: string
	triggers: TriggerResponse[]
	actors: ActorListItem[] | undefined
	childObjects: ObjectResponse[]
	loop?: LoopSummary
}) {
	const [agentFilter, setAgentFilter] = useState<string | null>(null)
	const { workspace } = useWorkspace()
	const actorsById = new Map((actors ?? []).map((a) => [a.id, a]))

	const primaryType = primaryChildType(childObjects)
	const primaryObjects = primaryType ? childObjects.filter((o) => o.type === primaryType) : []
	const configuredStatuses =
		(workspace.settings as { statuses?: Record<string, string[]> }).statuses?.[primaryType ?? ''] ??
		[]
	const columns = primaryType ? buildStageColumns(primaryObjects, configuredStatuses) : []

	const routineTriggers = triggers.filter((t) => t.type === 'cron')
	const eventTriggers = triggers.filter((t) => t.type !== 'cron')

	const distinctAgentIds = Array.from(new Set(triggers.map((t) => t.targetActorId)))
	const matchesFilter = (t: TriggerResponse) => !agentFilter || t.targetActorId === agentFilter
	const shownRoutines = routineTriggers.filter(matchesFilter)
	const shownEvents = eventTriggers.filter(matchesFilter)

	const hasTriggers = triggers.length > 0
	const hasStages = columns.some((c) => c.total > 0)
	if (!hasTriggers && !hasStages) return null

	// A pill filter that matches nothing renders the mockup's own line rather
	// than an empty card (mockup 1943–1945).
	const flowEmpty = agentFilter !== null && shownRoutines.length === 0 && shownEvents.length === 0

	const asksYou = loop?.pill === 'waiting_on_you'

	// `⟨primitives⟩ · ⟨triggers on⟩ · ⟨cycles⟩` — every part read off real data,
	// and any part with nothing to say drops out rather than printing a zero.
	const enabledTriggerCount = triggers.filter((t) => t.enabled).length
	const objectTypeCount = new Set(childObjects.map((o) => o.type)).size
	const inProgress = loop?.inProgressCount ?? 0
	const closed = loop?.closedCount ?? 0
	const median = formatDuration(loop?.medianTimeToCloseMs)
	const cycleParts: string[] = []
	if (inProgress > 0)
		cycleParts.push(`${inProgress} ${inProgress === 1 ? 'cycle is' : 'cycles are'} running`)
	if (closed > 0) cycleParts.push(`${closed} ${closed === 1 ? 'cycle has' : 'cycles have'} closed`)
	if (median) cycleParts.push(`median close ${median}`)
	const rightNowNote = [
		objectTypeCount > 0
			? `${objectTypeCount} object ${objectTypeCount === 1 ? 'type' : 'types'}`
			: null,
		`${enabledTriggerCount} of ${triggers.length} ${triggers.length === 1 ? 'trigger' : 'triggers'} on`,
		`${distinctAgentIds.length} ${distinctAgentIds.length === 1 ? 'agent' : 'agents'}`,
		...cycleParts,
	]
		.filter(Boolean)
		.join(' · ')

	return (
		<div id="loop-flow" data-loop-flow-root>
			{/* One note line: primitives · triggers on · cycles (mockup 1891). */}
			<div className="flex items-center gap-2.5 mb-3">
				<h2 className="shrink-0 text-sm font-semibold text-foreground">The loop, right now</h2>
				<span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
					{rightNowNote}
				</span>
			</div>

			{distinctAgentIds.length > 1 && (
				<div className="flex flex-wrap items-center gap-1.5 mb-3">
					<button
						type="button"
						onClick={() => setAgentFilter(null)}
						className={pillClasses(agentFilter === null)}
					>
						All steps
						<span className="text-[10.5px] text-border-strong">{triggers.length}</span>
					</button>
					{distinctAgentIds.map((agentId) => {
						const agent = actorsById.get(agentId)
						const count = triggers.filter((t) => t.targetActorId === agentId).length
						return (
							<button
								key={agentId}
								type="button"
								onClick={() => setAgentFilter(agentFilter === agentId ? null : agentId)}
								className={pillClasses(agentFilter === agentId)}
							>
								{agent?.name ?? 'Unknown agent'}
								<span className="text-[10.5px] text-border-strong">{count}</span>
							</button>
						)
					})}
				</div>
			)}

			<div className="border border-border rounded-xl bg-card p-3 flex flex-col gap-4 shadow-sm">
				{columns.map((column) => {
					const colors = getStatusColor(column.value)
					return (
						<div key={column.value}>
							<div className="flex items-center gap-2">
								<span
									className={cn('h-2 w-2 rounded-full', column.total > 0 ? colors.bg : 'bg-muted')}
								/>
								<span className="eyebrow">{column.label.replace(/_/g, ' ')}</span>
								<span
									className={cn(
										'inline-flex items-center rounded-full px-1.5 text-[10.5px] font-semibold',
										colors.bg,
										colors.text,
									)}
								>
									{column.total}
								</span>
							</div>
						</div>
					)
				})}

				{flowEmpty && (
					<p className="py-2 text-[12.5px] leading-relaxed text-muted-foreground">
						No step matches that filter.
					</p>
				)}

				{(shownRoutines.length > 0 || shownEvents.length > 0) && (
					<div className="flex flex-col gap-3">
						<span className="text-sm font-semibold text-foreground">Triggers</span>
						{shownRoutines.length > 0 && (
							<div>
								<div className="eyebrow mb-2">Routines</div>
								<div className="flex flex-col gap-2.5">
									{shownRoutines.map((t) => (
										<StepRow
											key={t.id}
											workspaceId={workspaceId}
											trigger={t}
											agent={actorsById.get(t.targetActorId)}
											asksYou={asksYou}
										/>
									))}
								</div>
							</div>
						)}
						{shownEvents.length > 0 && (
							<div>
								<div className="eyebrow mb-2">Event-based</div>
								<div className="flex flex-col gap-2.5">
									{shownEvents.map((t) => (
										<StepRow
											key={t.id}
											workspaceId={workspaceId}
											trigger={t}
											agent={actorsById.get(t.targetActorId)}
											asksYou={asksYou}
										/>
									))}
								</div>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	)
}
