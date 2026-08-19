import { ActorAvatar } from '@/components/shared/actor-avatar'
import { TypeBadge } from '@/components/shared/type-badge'
import type { ActorListItem, LoopSummary, ObjectResponse, TriggerResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getStatusColor } from '@/lib/constants'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { useQueries } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

// Relationship lookups are one request per object shown in the pipeline
// board (no bulk-by-many-ids endpoint exists yet) — capped so a very active
// loop can't fan out into a request storm.
const MAX_COMPANION_LOOKUPS = 30

/** Sentinel for the mockup's second pill — the steps that stop for a human. */
const ASKS_FILTER = 'asks'

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

/** Event triggers with an explicit `from_status` that matches a known stage
 * are placed right after that stage instead of in "Comes in" — mirrors the
 * reference design's mid-flow step rows (e.g. "Quill writes the
 * generalisable version" sitting right after the clustered stage). Cron/
 * reminder triggers and event triggers with no (or unrecognised)
 * `from_status` fall back to "Comes in" / "Runs alongside". */
function triggerFromStatus(trigger: TriggerResponse): string | null {
	if (trigger.type !== 'event') return null
	const config = trigger.config as { from_status?: unknown } | null
	const fromStatus = config?.from_status
	return typeof fromStatus === 'string' && fromStatus.length > 0 ? fromStatus : null
}

/**
 * A step "asks you" when its own instruction stops for a human — the mockup's
 * `s.badgeAsk` and the `Asks you` filter pill. Triggers carry no first-class
 * flag for this yet, so it is read from the action prompt the operator wrote;
 * a `stops_for_human` column on `triggers` would replace this read wholesale.
 */
const ASKS_OPERATOR_RE =
	/\b(?:ask|asks|confirm|confirms|approve|approves|approval|check)\b[^.!?]{0,40}\b(?:me|you|human|operator)\b/i

export function stepAsksYou(trigger: TriggerResponse): boolean {
	return ASKS_OPERATOR_RE.test(trigger.actionPrompt ?? '')
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
				<span className="text-muted-foreground">{trigger.actionPrompt}</span>
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

function CycleCard({
	workspaceId,
	primary,
	companions,
}: {
	workspaceId: string
	primary: ObjectResponse
	companions: ObjectResponse[]
}) {
	return (
		<div className="border border-border rounded-lg bg-background p-2.5">
			<Link
				to="/$workspaceId/objects/$objectId"
				params={{ workspaceId, objectId: primary.id }}
				className="text-[12px] font-semibold text-foreground truncate hover:underline"
			>
				{primary.title ?? 'Untitled'}
			</Link>
			<div className="flex flex-wrap gap-1.5 mt-2">
				{companions.map((obj) => (
					<Link
						key={obj.id}
						to="/$workspaceId/objects/$objectId"
						params={{ workspaceId, objectId: obj.id }}
						className="flex items-center gap-1.5 rounded-md border border-border bg-card px-1.5 py-1 hover:border-foreground/30 transition-colors min-w-0"
					>
						<TypeBadge type={obj.type} />
						<span className="text-[11px] font-medium text-foreground truncate max-w-[160px]">
							{obj.title ?? 'Untitled'}
						</span>
					</Link>
				))}
			</div>
		</div>
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
	// `null` = all steps, `'asks'` = only the steps that stop for the operator,
	// anything else = that agent's steps (mockup's pill strip).
	const [stepFilter, setStepFilter] = useState<string | null>(null)
	const { workspace } = useWorkspace()
	const actorsById = new Map((actors ?? []).map((a) => [a.id, a]))
	const childrenById = new Map(childObjects.map((c) => [c.id, c]))

	const primaryType = primaryChildType(childObjects)
	const primaryObjects = primaryType ? childObjects.filter((o) => o.type === primaryType) : []
	const configuredStatuses =
		(workspace.settings as { statuses?: Record<string, string[]> }).statuses?.[primaryType ?? ''] ??
		[]
	const columns = primaryType ? buildStageColumns(primaryObjects, configuredStatuses) : []

	// One relationship lookup per primary object — merged below into a
	// "companions" list (any loop child directly linked to it, any type).
	const lookupTargets = primaryObjects.slice(0, MAX_COMPANION_LOOKUPS)
	const relationshipQueries = useQueries({
		queries: lookupTargets.map((obj) => ({
			queryKey: queryKeys.relationships.byObject(workspaceId, obj.id),
			queryFn: () => api.relationships.list(workspaceId, { object_id: obj.id }),
		})),
	})
	const companionsByPrimaryId = new Map<string, ObjectResponse[]>()
	lookupTargets.forEach((obj, i) => {
		const rels = relationshipQueries[i]?.data ?? []
		const seen = new Set<string>()
		const companions: ObjectResponse[] = []
		for (const rel of rels) {
			const otherId = rel.sourceId === obj.id ? rel.targetId : rel.sourceId
			if (otherId === obj.id || seen.has(otherId)) continue
			const other = childrenById.get(otherId)
			if (other) {
				companions.push(other)
				seen.add(otherId)
			}
		}
		if (companions.length > 0) companionsByPrimaryId.set(obj.id, companions)
	})

	const cronTriggers = triggers.filter((t) => t.type === 'cron')
	const gapTriggersByStatus = new Map<string, TriggerResponse[]>()
	const comesInTriggers: TriggerResponse[] = []
	for (const t of triggers) {
		if (t.type === 'cron') continue
		const fromStatus = triggerFromStatus(t)
		if (fromStatus && columns.some((c) => c.value === fromStatus)) {
			const list = gapTriggersByStatus.get(fromStatus) ?? []
			list.push(t)
			gapTriggersByStatus.set(fromStatus, list)
		} else {
			comesInTriggers.push(t)
		}
	}

	const distinctAgentIds = Array.from(new Set(triggers.map((t) => t.targetActorId)))
	const asksYouCount = triggers.filter(stepAsksYou).length
	const matchesFilter = (t: TriggerResponse) => {
		if (stepFilter === null) return true
		if (stepFilter === ASKS_FILTER) return stepAsksYou(t)
		return t.targetActorId === stepFilter
	}
	const shownComesIn = comesInTriggers.filter(matchesFilter)
	const shownAlongside = cronTriggers.filter(matchesFilter)

	const hasTriggers = triggers.length > 0
	const hasStages = columns.some((c) => c.total > 0)
	if (!hasTriggers && !hasStages) return null

	// A pill filter that matches nothing renders the mockup's own line rather
	// than an empty card (mockup 1943–1945).
	const shownGapTriggerCount = columns.reduce(
		(sum, column) =>
			sum + (gapTriggersByStatus.get(column.value) ?? []).filter(matchesFilter).length,
		0,
	)
	const flowEmpty =
		stepFilter !== null &&
		shownComesIn.length === 0 &&
		shownAlongside.length === 0 &&
		shownGapTriggerCount === 0

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
		<div>
			{/* One note line: primitives · triggers on · cycles (mockup 1891). */}
			<div className="flex items-center gap-2.5 mb-3">
				<h2 className="shrink-0 text-sm font-semibold text-foreground">The loop, right now</h2>
				<span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
					{rightNowNote}
				</span>
			</div>

			{/* Step pills (mockup 1897–1905): all steps, the ones that stop for you,
			    then one per agent with its own plate — filtering the flow below. */}
			<div className="mb-3 flex flex-wrap items-center gap-1.5">
				<button
					type="button"
					aria-pressed={stepFilter === null}
					onClick={() => setStepFilter(null)}
					className={pillClasses(stepFilter === null)}
				>
					All steps
					<span className="text-[10.5px] text-border-strong">{triggers.length}</span>
				</button>
				{asksYouCount > 0 && (
					<button
						type="button"
						aria-pressed={stepFilter === ASKS_FILTER}
						onClick={() => setStepFilter(stepFilter === ASKS_FILTER ? null : ASKS_FILTER)}
						className={pillClasses(stepFilter === ASKS_FILTER)}
					>
						Asks you
						<span className="text-[10.5px] text-border-strong">{asksYouCount}</span>
					</button>
				)}
				{distinctAgentIds.map((agentId) => {
					const agent = actorsById.get(agentId)
					const count = triggers.filter((t) => t.targetActorId === agentId).length
					return (
						<button
							key={agentId}
							type="button"
							aria-pressed={stepFilter === agentId}
							onClick={() => setStepFilter(stepFilter === agentId ? null : agentId)}
							className={pillClasses(stepFilter === agentId)}
						>
							<ActorAvatar
								id={agentId}
								name={agent?.name ?? 'Unknown agent'}
								type={agent?.type ?? 'agent'}
								className="size-[15px] text-[7.5px]"
							/>
							{agent?.name ?? 'Unknown agent'}
							<span className="text-[10.5px] text-border-strong">{count}</span>
						</button>
					)
				})}
			</div>

			<div className="border border-border rounded-xl bg-card p-3 flex flex-col gap-4 shadow-sm">
				{shownComesIn.length > 0 && (
					<div>
						<div className="flex items-baseline gap-2 mb-2">
							<span className="eyebrow">Comes in</span>
							<span className="text-[10.5px] text-muted-foreground/70">
								how work reaches the loop
							</span>
						</div>
						<div className="flex flex-col gap-2.5">
							{shownComesIn.map((t) => (
								<StepRow
									key={t.id}
									workspaceId={workspaceId}
									trigger={t}
									agent={actorsById.get(t.targetActorId)}
									asksYou={stepAsksYou(t)}
								/>
							))}
						</div>
					</div>
				)}

				{columns.map((column) => {
					const colors = getStatusColor(column.value)
					const cardObjects = column.objects.filter((o) => companionsByPrimaryId.has(o.id))
					const gapTriggers = (gapTriggersByStatus.get(column.value) ?? []).filter(matchesFilter)
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
							{cardObjects.length > 0 && (
								<div className="flex flex-col gap-2 mt-2 ml-4">
									{cardObjects.map((obj) => (
										<CycleCard
											key={obj.id}
											workspaceId={workspaceId}
											primary={obj}
											companions={companionsByPrimaryId.get(obj.id) ?? []}
										/>
									))}
								</div>
							)}
							{gapTriggers.length > 0 && (
								<div className="flex flex-col gap-2.5 mt-2 ml-4">
									{gapTriggers.map((t) => (
										<StepRow
											key={t.id}
											workspaceId={workspaceId}
											trigger={t}
											agent={actorsById.get(t.targetActorId)}
											asksYou={stepAsksYou(t)}
										/>
									))}
								</div>
							)}
						</div>
					)
				})}

				{flowEmpty && (
					<p className="py-2 text-[12.5px] leading-relaxed text-muted-foreground">
						No step matches that filter.
					</p>
				)}

				{shownAlongside.length > 0 && (
					<div>
						<div className="flex items-baseline gap-2 mb-2">
							<span className="eyebrow">Runs alongside</span>
							<span className="text-[10.5px] text-muted-foreground/70">
								schedules and safety nets
							</span>
						</div>
						<div className="flex flex-col gap-2.5">
							{shownAlongside.map((t) => (
								<StepRow
									key={t.id}
									workspaceId={workspaceId}
									trigger={t}
									agent={actorsById.get(t.targetActorId)}
									asksYou={stepAsksYou(t)}
								/>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	)
}
