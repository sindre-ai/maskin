import { ActorAvatar } from '@/components/shared/actor-avatar'
import { readEventStatusTransition } from '@/components/triggers/trigger-form'
import { describeTrigger } from '@/components/triggers/trigger-row'
import { Switch } from '@/components/ui/switch'
import { useCanWrite } from '@/hooks/use-can-write'
import { useUpdateTrigger } from '@/hooks/use-triggers'
import type { ActorListItem, LoopSummary, TriggerResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { statusLabel, typeLabel } from '@/lib/constants'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { toast } from 'sonner'

/** Triggers that fire when an item reaches one status, in the order the flow names them. */
interface StatusColumn {
	status: string
	triggers: TriggerResponse[]
}

/** One row of status boxes for an item type, in the order the workspace schema lists them. */
interface StatusRow {
	entityType: string
	columns: StatusColumn[]
}

/** A trigger the status rows cannot place, with the status it names when that status is unknown. */
interface StripEntry {
	trigger: TriggerResponse
	rawStatus?: string
}

interface TriggerPlacement {
	rows: StatusRow[]
	/** Schedules and reminders. */
	scheduled: StripEntry[]
	/** Event triggers that fire on any status, on create or update, or on a status the schema lacks. */
	anyChange: StripEntry[]
}

/**
 * Places each trigger under the status it fires on. Order follows the flow's own trigger order
 * (`LoopSummary.triggerIds`), else A to Z by name. A row exists for each item type that has at
 * least one placed trigger; status order and names come from the workspace schema, not from here.
 */
function placeTriggers(
	triggers: TriggerResponse[],
	statusesByType: Record<string, string[]>,
	spine: readonly string[] | undefined,
): TriggerPlacement {
	const rank = (t: TriggerResponse) => {
		const at = spine?.indexOf(t.id) ?? -1
		return at === -1 ? Number.MAX_SAFE_INTEGER : at
	}
	const ordered = [...triggers].sort(
		(a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
	)
	const rows = new Map<string, Map<string, TriggerResponse[]>>()
	const scheduled: StripEntry[] = []
	const anyChange: StripEntry[] = []
	for (const trigger of ordered) {
		if (trigger.type !== 'event') {
			scheduled.push({ trigger })
			continue
		}
		const config = trigger.config ?? {}
		const entityType = typeof config.entity_type === 'string' ? config.entity_type : ''
		const { toStatus } = readEventStatusTransition(config)
		if (config.action !== 'status_changed' || toStatus === '__any__') {
			anyChange.push({ trigger })
			continue
		}
		if (!statusesByType[entityType]?.includes(toStatus)) {
			anyChange.push({ trigger, rawStatus: toStatus })
			continue
		}
		const row = rows.get(entityType) ?? new Map<string, TriggerResponse[]>()
		row.set(toStatus, [...(row.get(toStatus) ?? []), trigger])
		rows.set(entityType, row)
	}
	return {
		rows: [...rows].map(([entityType, byStatus]) => ({
			entityType,
			columns: statusesByType[entityType].map((status) => ({
				status,
				triggers: byStatus.get(status) ?? [],
			})),
		})),
		scheduled,
		anyChange,
	}
}

function TriggerCard({
	workspaceId,
	trigger,
	agent,
	note,
}: {
	workspaceId: string
	trigger: TriggerResponse
	/** The agent the trigger wakes. */
	agent: ActorListItem | undefined
	/** Extra line on the card, for example the status it fires from. */
	note?: string
}) {
	const canWrite = useCanWrite()
	const update = useUpdateTrigger(workspaceId)
	const kind = trigger.type === 'cron' ? 'Schedule' : 'Event'
	// The card reads as what happens: the trigger's name, then the first line of what it asks the
	// agent to do. A trigger with neither says when it fires, so no card is ever blank.
	const when = describeTrigger(trigger)
	const instruction = trigger.actionPrompt?.trim().split('\n')[0]?.slice(0, 160) ?? ''
	const title = trigger.name?.trim() || instruction || when
	const detail = instruction && instruction !== title ? instruction : title !== when ? when : ''
	return (
		// The card opens the trigger's own page; the switch sits on top of it and acts
		// without opening it. With `/triggers` folded into flows, this card is the only
		// route into a flow-owned trigger's detail page.
		<div
			className={cn(
				'relative rounded-xl bg-muted transition-opacity',
				!trigger.enabled && 'opacity-55',
			)}
		>
			<Link
				to="/$workspaceId/triggers/$triggerId"
				params={{ workspaceId, triggerId: trigger.id }}
				className="flex flex-col gap-1 rounded-xl px-3 py-2.5 transition-colors duration-150 hover:bg-border/50"
			>
				<span className="pr-10 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
					{kind}
				</span>
				<span className="min-w-0 break-words text-[13px] leading-[1.35] text-foreground">
					{title}
				</span>
				{detail && (
					<span className="min-w-0 break-words text-[12px] leading-[1.35] text-muted-foreground">
						{detail}
					</span>
				)}
				{note && (
					<span className="min-w-0 break-words text-[12px] leading-[1.35] text-muted-foreground">
						{note}
					</span>
				)}
				<span className="mt-0.5 flex items-center gap-1.5">
					<ActorAvatar
						id={trigger.targetActorId}
						name={agent?.name ?? 'Unknown agent'}
						type={agent?.type ?? 'agent'}
						size="sm"
						className="shrink-0"
					/>
					<span className="min-w-0 truncate text-[12px] text-muted-foreground">
						{agent?.name ?? 'Unknown agent'}
					</span>
				</span>
			</Link>
			<Switch
				checked={trigger.enabled}
				disabled={!canWrite || update.isPending}
				aria-label={`${trigger.enabled ? 'Pause' : 'Turn on'} ${title}`}
				onCheckedChange={(enabled) =>
					update.mutate(
						{ id: trigger.id, data: { enabled } },
						{ onError: () => toast.error('Could not update the trigger') },
					)
				}
				className="absolute right-3 top-2.5 data-[state=checked]:bg-brand"
			/>
		</div>
	)
}

export function LoopFlow({
	workspaceId,
	triggers,
	actors,
	loop,
	onAddTrigger,
	addingTrigger = false,
}: {
	workspaceId: string
	triggers: TriggerResponse[]
	actors: ActorListItem[] | undefined
	loop?: LoopSummary
	/** Adds a trigger to this flow. Omitted for viewers, so the control is not offered. */
	onAddTrigger?: () => void
	/** A trigger is being added; the control waits so a double click adds one. */
	addingTrigger?: boolean
}) {
	const { workspace } = useWorkspace()
	const statusesByType =
		((workspace.settings as Record<string, unknown> | null)?.statuses as
			| Record<string, string[]>
			| undefined) ?? {}
	const actorsById = new Map((actors ?? []).map((a) => [a.id, a]))
	const { rows, scheduled, anyChange } = placeTriggers(triggers, statusesByType, loop?.triggerIds)
	const card = (t: TriggerResponse, note?: string) => (
		<TriggerCard
			key={t.id}
			workspaceId={workspaceId}
			trigger={t}
			agent={actorsById.get(t.targetActorId)}
			note={note}
		/>
	)

	return (
		<section
			id="loop-flow"
			data-loop-flow-root
			aria-label="How it runs"
			className="flex flex-col gap-3.5"
		>
			<div className="flex items-baseline gap-3 px-1">
				<h2 className="flex-1 text-[13px] font-semibold text-muted-foreground">How it runs</h2>
				{onAddTrigger && (
					<button
						type="button"
						onClick={onAddTrigger}
						disabled={addingTrigger}
						className="text-[12.5px] font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
					>
						+ Add trigger
					</button>
				)}
			</div>

			{triggers.length > 0 && (
				<div
					data-testid="loop-pipeline"
					className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-background shadow-xs"
				>
					{rows.map((row) => (
						<div
							key={row.entityType}
							data-testid={`loop-status-row-${row.entityType}`}
							className="flex flex-col gap-3 px-4 pb-4 pt-[18px]"
						>
							{rows.length > 1 && (
								<h3 className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
									{typeLabel(row.entityType)}
								</h3>
							)}
							<div className="flex items-start gap-1 overflow-x-auto">
								{row.columns.map((column, index) => (
									<Fragment key={column.status}>
										{index > 0 && (
											<ArrowRight
												aria-hidden
												className="mt-[7px] size-4 shrink-0 text-muted-foreground"
											/>
										)}
										<div
											data-testid={`loop-status-${row.entityType}-${column.status}`}
											className="flex w-52 shrink-0 flex-col gap-2"
										>
											<span className="rounded-lg border border-border px-3 py-1 text-[12.5px] font-semibold first-letter:uppercase text-foreground">
												{statusLabel(column.status)}
											</span>
											{column.triggers.map((t) => {
												const { fromStatus } = readEventStatusTransition(t.config)
												return card(t, fromStatus === '__any__' ? undefined : `from ${fromStatus}`)
											})}
										</div>
									</Fragment>
								))}
							</div>
						</div>
					))}
					{(anyChange.length > 0 || scheduled.length > 0) && (
						<div className="flex flex-col gap-3.5 px-4 pb-4 pt-[18px]">
							{anyChange.length > 0 && (
								<TriggerStrip label="Any change">
									{anyChange.map(({ trigger, rawStatus }) =>
										card(trigger, rawStatus ? `fires on ${rawStatus}` : undefined),
									)}
								</TriggerStrip>
							)}
							{scheduled.length > 0 && (
								<TriggerStrip label="Runs on a schedule">
									{scheduled.map(({ trigger }) => card(trigger))}
								</TriggerStrip>
							)}
						</div>
					)}
				</div>
			)}

			{triggers.length === 0 && (
				<p className="px-1 text-sm text-muted-foreground">This flow runs when you ask.</p>
			)}
		</section>
	)
}

/** A labelled group of trigger cards that have no status to sit under. */
function TriggerStrip({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-2">
			<h3 className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
				{label}
			</h3>
			<div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">{children}</div>
		</div>
	)
}
