import { ActorAvatar } from '@/components/shared/actor-avatar'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { useCanWrite } from '@/hooks/use-can-write'
import { useIntegrations, useProviders } from '@/hooks/use-integrations'
import { cn } from '@/lib/cn'
import { type LoopPlan, describeLoopPlan, summariseLoopPlan } from '@/lib/loop-plan'
import { getRequiredIntegrationsForPlan } from '@maskin/shared'
import { Link } from '@tanstack/react-router'
import { Check, Plus } from 'lucide-react'
import { useState } from 'react'

export function defaultLoopName(plan: LoopPlan): string {
	const base = plan.objectTypes[0]?.name ?? 'Flow'
	return `${base} flow`
}

function SectionLabel({ children, className }: { children: string; className?: string }) {
	return <div className={cn('eyebrow', className)}>{children}</div>
}

// Creating a loop persists the loop object and the plan snapshot it was drawn
// from — it does not yet provision the object types, triggers and agents the
// card lists above. Until it does, this copy must not claim the loop is
// running: a loop with no trigger attached will never fire, and
// `LoopFirstRunBanner` on the detail page says exactly that.
const CREATED_DESCRIPTION =
	'Saved, along with the plan it was drawn from. Nothing fires yet — the item types, triggers and agents above are still a preview until they are attached to the flow.'

/** `NEW TYPE` / `JUST ADDED` — the brand-tinted "this doesn't exist yet" marker
 *  (mockup 2168, 2197–2198). Distinct from a trigger's `kindLabel`. */
function NewBadge({ children }: { children: string }) {
	return (
		<span className="shrink-0 rounded-md bg-brand-subtle px-1.5 py-1 font-mono text-[8.5px] font-bold tracking-wider text-brand-subtle-foreground">
			{children}
		</span>
	)
}

/** Providers the plan needs that this workspace has not connected yet, by
 *  display name. Shared by the pinned row, the footer line and the Create gate
 *  so all three always agree. */
function useMissingIntegrations(plan: LoopPlan, workspaceId: string) {
	const { data: providers } = useProviders()
	const { data: integrations } = useIntegrations(workspaceId)
	const providerByName = new Map((providers ?? []).map((p) => [p.name, p]))
	const connectedNames = new Set(
		(integrations ?? []).filter((row) => row.status === 'active').map((row) => row.provider),
	)
	const known = getRequiredIntegrationsForPlan(plan.triggers).filter((name) =>
		providerByName.has(name),
	)
	const missing = known
		.filter((name) => !connectedNames.has(name))
		.map((name) => providerByName.get(name)?.displayName ?? name)
	return { known, missing, providerByName, connectedNames }
}

/** The plan as a numbered run of steps: what fires, who does it, and the one
 *  place it stops for the operator (mockup 3f). */
function StepDiagram({ plan }: { plan: LoopPlan }) {
	if (plan.triggers.length === 0 && !plan.stopForOperator) return null
	return (
		<ol aria-label="Steps" className="flex flex-col gap-2 border-b border-border px-5 py-4">
			{plan.triggers.map((t, i) => (
				<li
					// biome-ignore lint/suspicious/noArrayIndexKey: plan-derived triggers have no stable id and order is deterministic
					key={i}
					className="flex items-start gap-2.5"
				>
					<span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[10px] font-bold text-muted-foreground">
						{i + 1}
					</span>
					<span className="min-w-0 text-xs leading-relaxed text-foreground">
						<span className="font-semibold">{t.targetAgent}</span>{' '}
						<span className="text-muted-foreground">
							{t.thenWrites
								.map((w) => `${w.act.replace('_', ' ')} ${w.type ?? ''}`.trim())
								.join(', ')}
						</span>
					</span>
				</li>
			))}
			{plan.stopForOperator && (
				<li className="flex items-start gap-2.5">
					<span className="inline-flex shrink-0 items-center rounded-md bg-ask-surface px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-foreground ring-1 ring-ask-border">
						Stops for you
					</span>
				</li>
			)}
		</ol>
	)
}

export interface LoopPlanCardProps {
	plan: LoopPlan
	onCreate: () => void
	onStartOver: () => void
	creating?: boolean
	created?: boolean
	createdId?: string | null
	workspaceId: string
}

export function LoopPlanCard({
	plan,
	onCreate,
	onStartOver,
	creating,
	created,
	createdId,
	workspaceId,
}: LoopPlanCardProps) {
	const canWrite = useCanWrite()
	const { missing } = useMissingIntegrations(plan, workspaceId)
	const [skipped, setSkipped] = useState(false)
	const blocked = missing.length > 0 && !skipped
	const title = created ? 'Flow created' : defaultLoopName(plan)
	return (
		<div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
			<div className="flex flex-col gap-2 border-b border-border px-5 py-4">
				<div className="flex items-center gap-2">
					{created ? <Check size={14} className="shrink-0 text-success" aria-hidden /> : null}
					<SectionLabel>{created ? 'FLOW CREATED' : 'PROPOSED FLOW'}</SectionLabel>
					<span className="ml-auto text-[11px] text-muted-foreground">
						{created ? 'created' : 'not created yet'}
					</span>
				</div>
				<h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
				<p className="text-xs leading-relaxed text-muted-foreground">
					{created ? CREATED_DESCRIPTION : describeLoopPlan(plan)}
				</p>
				{created && (
					<p className="text-xs font-semibold leading-relaxed text-foreground">
						{missing.length > 0
							? `Next: connect ${missing.join(', ')} so the triggers can fire.`
							: 'Next: open the flow and attach its triggers.'}
					</p>
				)}
			</div>

			{!created && <StepDiagram plan={plan} />}

			<div className="flex max-h-[50vh] flex-col gap-5 overflow-y-auto px-5 py-4 lg:max-h-[60vh]">
				<section>
					<SectionLabel>ITEM TYPES</SectionLabel>
					<div className="mt-2.5 flex flex-col gap-2">
						{plan.objectTypes.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								No items detected yet. Describe what should be tracked.
							</p>
						) : (
							plan.objectTypes.map((t, i) => (
								<div key={`${t.type}-${i}`} className="rounded-xl border border-border bg-card p-3">
									<div className="flex flex-wrap items-center gap-2">
										<span className="inline-flex items-center rounded-md bg-muted px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-foreground">
											{t.name}
										</span>
										{t.isNew && <NewBadge>NEW TYPE</NewBadge>}
										<span className="text-xs text-muted-foreground">{t.role}</span>
										{t.live && (
											<span className="ml-auto whitespace-nowrap text-[11px] text-muted-foreground">
												{t.live}
											</span>
										)}
									</div>
									{t.readOnly && t.note ? (
										<p className="mt-2.5 text-[11.5px] leading-snug text-muted-foreground">
											{t.note}
										</p>
									) : null}
									{!t.readOnly && t.stateChain.length > 0 && (
										<div className="mt-2.5 flex flex-wrap items-center gap-1.5">
											{t.stateChain.map((state, si) => (
												<span key={state} className="inline-flex items-center gap-1.5">
													<StatusBadge status={state} />
													{si < t.stateChain.length - 1 && (
														<span aria-hidden className="text-xs text-muted-foreground">
															→
														</span>
													)}
												</span>
											))}
										</div>
									)}
								</div>
							))
						)}
					</div>
				</section>

				<section>
					<SectionLabel>TRIGGERS</SectionLabel>
					<div className="mt-2.5 flex flex-col gap-2">
						{plan.triggers.length === 0 ? (
							<p className="text-sm text-muted-foreground">Nothing triggers the flow yet.</p>
						) : (
							plan.triggers.map((t, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: plan-derived triggers have no stable id and order is deterministic
									key={i}
									className="rounded-xl border border-border bg-card p-3"
								>
									<div className="flex flex-wrap items-center gap-2">
										<span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-muted font-mono text-[10px] font-bold text-muted-foreground">
											{i + 1}
										</span>
										<span className="inline-flex items-center rounded-md bg-muted px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-foreground">
											{t.kindLabel}
										</span>
										{t.isNew && <NewBadge>JUST ADDED</NewBadge>}
										{t.whenChip && (
											<span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-1.5 py-1">
												<TypeBadge type={t.whenChip.type} />
												{t.whenChip.state && <StatusBadge status={t.whenChip.state} />}
											</span>
										)}
									</div>
									<p className="mt-2.5 text-xs leading-relaxed text-foreground">
										<span className="eyebrow mr-1.5 inline">WHEN</span>
										{t.whenClause}
									</p>
									<div className="mt-2 flex items-center gap-2">
										<ActorAvatar name={t.targetAgent} type="agent" />
										<span className="text-xs font-semibold text-foreground">{t.targetAgent}</span>
									</div>
									<div className="mt-2 flex flex-wrap items-center gap-2">
										<span className="eyebrow">THEN</span>
										<span className="text-xs text-muted-foreground">
											{t.thenWrites.map((w) => `${w.act} ${w.type ?? ''}`.trim()).join(' · ')}
										</span>
									</div>
									{t.asks && (
										<div className="mt-2.5 flex flex-wrap items-baseline gap-2 border-t border-border pt-2.5">
											<span className="eyebrow text-warning">ASKS</span>
											<span className="text-xs text-foreground">{t.asks}</span>
										</div>
									)}
								</div>
							))
						)}
					</div>
				</section>

				<section>
					<SectionLabel>AGENTS · from your crew, nobody new to hire</SectionLabel>
					<div className="mt-2.5 overflow-hidden rounded-xl border border-border">
						{plan.agents.length === 0 ? (
							<p className="p-3 text-sm text-muted-foreground">No agents assigned yet.</p>
						) : (
							plan.agents.map((a, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: plan-derived agents have no stable id and order is deterministic
									key={i}
									className={cn(
										'flex items-center gap-2.5 bg-card p-3',
										i < plan.agents.length - 1 && 'border-b border-border',
									)}
								>
									<ActorAvatar name={a.name} type="agent" />
									<div className="min-w-0 flex-1">
										<p className="truncate text-sm font-semibold text-foreground">{a.name}</p>
										<p className="truncate text-xs text-muted-foreground">{a.role}</p>
									</div>
									<span className="shrink-0 whitespace-nowrap font-mono text-[9.5px] font-semibold text-muted-foreground">
										{a.count} {a.count === 1 ? 'step' : 'steps'}
									</span>
								</div>
							))
						)}
					</div>
				</section>

				{plan.stopForOperator && (
					<section>
						<SectionLabel>WHERE IT WILL STOP FOR YOU</SectionLabel>
						<div className="mt-2.5 rounded-xl border border-ask-border bg-ask-surface px-3 py-2.5">
							<p className="text-xs leading-relaxed text-foreground">{plan.stopForOperator}</p>
						</div>
					</section>
				)}
			</div>

			{!created && plan.triggers.length > 0 && (
				<NeedsConnectedSection
					plan={plan}
					workspaceId={workspaceId}
					skipped={skipped}
					onSkip={() => setSkipped(true)}
				/>
			)}

			<div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted px-5 py-3.5">
				{created ? (
					<>
						<Button size="sm" className="max-md:min-h-11" asChild>
							<Link
								to="/$workspaceId/loops/$loopId"
								params={{ workspaceId, loopId: createdId ?? '' }}
							>
								Open flow
							</Link>
						</Button>
						<Button size="sm" variant="ghost" className="max-md:min-h-11" onClick={onStartOver}>
							Start over
						</Button>
					</>
				) : (
					<>
						<FooterSummary plan={plan} workspaceId={workspaceId} />
						<Button
							size="sm"
							variant="ghost"
							className="max-md:min-h-11"
							onClick={onStartOver}
							disabled={creating}
						>
							Start over
						</Button>
						<ViewerTooltip>
							<Button
								size="sm"
								className="max-md:min-h-11"
								onClick={onCreate}
								disabled={creating || !canWrite || blocked}
							>
								{creating ? (
									'Creating…'
								) : (
									<>
										<Plus size={14} className="mr-1" aria-hidden />
										Create flow
									</>
								)}
							</Button>
						</ViewerTooltip>
					</>
				)}
			</div>
		</div>
	)
}

/**
 * NEEDS THESE CONNECTED — D9 section, rendered under WHERE IT WILL STOP FOR
 * YOU (or as the last section when there is no stop-for-you clause).
 *
 * Requirements are derived from the plan by the shared helper
 * `getRequiredIntegrationsForPlan` — same import trigger-runner uses at
 * create time. Connected state is the current workspace's integrations list
 * filtered to active rows. A missing chip carries an inline **Connect**
 * that opens the workspace's integrations settings page in a new tab; the
 * chip auto-flips to ✓ connected on return via TanStack Query's window-focus
 * refetch (no page reload of /loops/new).
 */
function NeedsConnectedSection({
	plan,
	workspaceId,
	skipped,
	onSkip,
}: {
	plan: LoopPlan
	workspaceId: string
	skipped: boolean
	onSkip: () => void
}) {
	const { known, missing, providerByName, connectedNames } = useMissingIntegrations(
		plan,
		workspaceId,
	)

	if (known.length === 0) {
		return (
			<section aria-label="Integrations required" className="border-t border-border px-5 py-3.5">
				<SectionLabel>NEEDS THESE CONNECTED</SectionLabel>
				<p className="mt-2.5 text-[11.5px] leading-snug text-muted-foreground">
					No integrations required — this plan runs on Maskin alone.
				</p>
			</section>
		)
	}

	return (
		<section aria-label="Integrations required" className="border-t border-border px-5 py-3.5">
			<div className="flex items-center gap-2">
				<SectionLabel>NEEDS THESE CONNECTED</SectionLabel>
				{missing.length > 0 && !skipped && (
					<Button size="sm" variant="ghost" className="ml-auto max-md:min-h-11" onClick={onSkip}>
						Skip for now
					</Button>
				)}
			</div>
			{missing.length > 0 && (
				<p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
					{skipped
						? 'Skipped. The flow is created, but these steps cannot run until they are connected.'
						: 'Connect these first, or skip them, to create the flow.'}
				</p>
			)}
			<ul className="mt-2.5 flex flex-col gap-1.5">
				{known.map((providerName) => {
					const provider = providerByName.get(providerName)
					const label = provider?.displayName ?? providerName
					const connected = connectedNames.has(providerName)
					return (
						<li
							key={providerName}
							className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5"
						>
							<span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
								{label}
							</span>
							{connected ? (
								<span
									className="inline-flex shrink-0 items-center gap-1 rounded-md bg-success/10 px-1.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-success"
									aria-label={`${label} connected`}
								>
									<Check size={11} aria-hidden />
									connected
								</span>
							) : (
								<>
									<span
										className="inline-flex shrink-0 items-center gap-1 rounded-md bg-warning/10 px-1.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-warning"
										aria-label={`${label} needs connecting`}
									>
										needs connecting
									</span>
									{/* Opens in a new tab so /loops/new stays mounted; the window-focus
									 *  refetch flips the row to connected on return. Plain `<a>`: the typed
									 *  Link on the integrations route demands its search schema. */}
									<Button size="sm" variant="outline" className="max-md:min-h-11" asChild>
										<a
											href={`/${workspaceId}/settings/integrations`}
											target="_blank"
											rel="noreferrer"
										>
											Connect
										</a>
									</Button>
								</>
							)}
						</li>
					)
				})}
			</ul>
		</section>
	)
}

/** Footer sentence: what the card holds, and what Create will do next. */
function FooterSummary({ plan, workspaceId }: { plan: LoopPlan; workspaceId: string }) {
	const { missing } = useMissingIntegrations(plan, workspaceId)
	const summaryLine = summariseLoopPlan(plan)
	const connectSentence = missing.length > 0 ? buildConnectSentence(missing) : null
	return (
		<span className="mr-auto min-w-[180px] flex-1 text-[11px] leading-relaxed text-muted-foreground">
			{connectSentence ? `${summaryLine} ${connectSentence}` : summaryLine}
		</span>
	)
}

/** "Connect X to enable Y." — SPEC verbatim. Y is the first trigger's core
 *  intent (kindLabel-derived); we keep it short so the sentence stays under
 *  the footer's single line. */
function buildConnectSentence(missingDisplayNames: string[]): string {
	if (missingDisplayNames.length === 0) return ''
	const list =
		missingDisplayNames.length === 1
			? missingDisplayNames[0]
			: `${missingDisplayNames.slice(0, -1).join(', ')} and ${
					missingDisplayNames[missingDisplayNames.length - 1]
				}`
	return `Connect ${list} to enable this flow.`
}
