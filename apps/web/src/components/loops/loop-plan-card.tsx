import { ActorAvatar } from '@/components/shared/actor-avatar'
import { StatusBadge } from '@/components/shared/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'
import type { LoopPlan } from '@/lib/loop-plan'
import { Link } from '@tanstack/react-router'
import { Check, Plus } from 'lucide-react'

export interface PlanEditDraft {
	name: string
	objectTypeName: string
	stateChain: string[]
	agentName: string
	stopForOperator: string
}

export function defaultLoopName(plan: LoopPlan): string {
	const base = plan.objectTypes[0]?.name ?? 'Loop'
	return `${base} loop`
}

export function draftFromPlan(plan: LoopPlan): PlanEditDraft {
	const firstType = plan.objectTypes[0]
	const firstAgent = plan.agents[0]
	return {
		name: defaultLoopName(plan),
		objectTypeName: firstType?.name ?? '',
		stateChain: firstType?.stateChain ?? [],
		agentName: firstAgent?.name ?? '',
		stopForOperator: plan.stopForOperator ?? '',
	}
}

export function mergeDraftOntoPlan(plan: LoopPlan, draft: PlanEditDraft): LoopPlan {
	const objectTypes = plan.objectTypes.map((t, i) =>
		i === 0
			? {
					...t,
					name: draft.objectTypeName.trim() || t.name,
					stateChain: draft.stateChain.length > 0 ? draft.stateChain : t.stateChain,
				}
			: t,
	)
	const agents = plan.agents.map((a, i) =>
		i === 0 ? { ...a, name: draft.agentName.trim() || a.name } : a,
	)
	return {
		...plan,
		objectTypes,
		agents,
		stopForOperator: draft.stopForOperator.trim() || plan.stopForOperator,
	}
}

function SectionLabel({ children, className }: { children: string; className?: string }) {
	return <div className={cn('eyebrow', className)}>{children}</div>
}

export interface LoopPlanCardProps {
	plan: LoopPlan
	draft: PlanEditDraft
	mode: 'proposed' | 'editing'
	onDraftChange: (draft: PlanEditDraft) => void
	onAdjust: () => void
	onSave: () => void
	onCreate: () => void
	onDone: () => void
	creating?: boolean
	created?: boolean
	createdId?: string | null
	workspaceId: string
}

export function LoopPlanCard({
	plan,
	draft,
	mode,
	onDraftChange,
	onAdjust,
	onSave,
	onCreate,
	onDone,
	creating,
	created,
	createdId,
	workspaceId,
}: LoopPlanCardProps) {
	const editing = mode === 'editing'

	const setStateChain = (raw: string) =>
		onDraftChange({
			...draft,
			stateChain: raw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean),
		})

	const title = created ? 'Loop created' : draft.name.trim() || defaultLoopName(plan)

	return (
		<div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
			<div className="flex flex-col gap-2 border-b border-border px-5 py-4">
				<div className="flex items-center gap-2">
					{created ? <Check size={14} className="shrink-0 text-success" aria-hidden /> : null}
					<SectionLabel>{created ? 'LOOP CREATED' : 'PROPOSED LOOP'}</SectionLabel>
					<span className="ml-auto text-[11px] text-muted-foreground">
						{created ? 'created' : 'not created yet'}
					</span>
				</div>
				<h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
				<p className="text-xs leading-relaxed text-muted-foreground">
					{created
						? 'Your loop is running. Open it to watch it move.'
						: 'Read this back before it becomes real. Nothing exists in your workspace yet.'}
				</p>
			</div>

			<div className="flex max-h-[50vh] flex-col gap-5 overflow-y-auto px-5 py-4 lg:max-h-[60vh]">
				<section>
					<SectionLabel>OBJECT TYPES</SectionLabel>
					<div className="mt-2.5 flex flex-col gap-2">
						{plan.objectTypes.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								No objects detected yet. Describe what should be tracked.
							</p>
						) : (
							plan.objectTypes.map((t, i) => (
								<div key={`${t.type}-${i}`} className="rounded-lg border border-border bg-card p-3">
									<div className="flex flex-wrap items-center gap-2">
										{editing && i === 0 ? (
											<Input
												value={draft.objectTypeName}
												onChange={(e) =>
													onDraftChange({ ...draft, objectTypeName: e.target.value })
												}
												className="h-8 w-44 text-sm"
												aria-label="Object type name"
											/>
										) : (
											<span className="inline-flex items-center rounded-md bg-muted px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-foreground">
												{t.name}
											</span>
										)}
										<span className="text-xs text-muted-foreground">{t.role}</span>
										{t.live && (
											<span className="ml-auto text-[11px] text-muted-foreground">
												tracked live
											</span>
										)}
									</div>
									{editing && i === 0 ? (
										<Input
											value={draft.stateChain.join(', ')}
											onChange={(e) => setStateChain(e.target.value)}
											className="mt-2.5 h-8 text-sm"
											placeholder="todo, in_progress, done"
											aria-label="State chain"
										/>
									) : (
										t.stateChain.length > 0 && (
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
										)
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
							<p className="text-sm text-muted-foreground">Nothing triggers the loop yet.</p>
						) : (
							plan.triggers.map((t, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: plan-derived triggers have no stable id and order is deterministic
									key={i}
									className="rounded-lg border border-border bg-card p-3"
								>
									<div className="flex flex-wrap items-center gap-2">
										<span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-muted font-mono text-[10px] font-bold text-muted-foreground">
											{i + 1}
										</span>
										<span className="inline-flex items-center rounded-md bg-muted px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-foreground">
											{t.kindLabel}
										</span>
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
					<SectionLabel>AGENTS</SectionLabel>
					<div className="mt-2.5 overflow-hidden rounded-lg border border-border">
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
										{editing && i === 0 ? (
											<Input
												value={draft.agentName}
												onChange={(e) => onDraftChange({ ...draft, agentName: e.target.value })}
												className="h-8 text-sm"
												aria-label="Agent name"
											/>
										) : (
											<p className="truncate text-sm font-semibold text-foreground">
												{a.name}
												{a.count > 1 ? ` ×${a.count}` : ''}
											</p>
										)}
										<p className="truncate text-xs text-muted-foreground">{a.role}</p>
									</div>
								</div>
							))
						)}
					</div>
				</section>

				{plan.stopForOperator && (
					<section>
						<SectionLabel>WHERE IT WILL STOP FOR YOU</SectionLabel>
						<div className="mt-2.5 rounded-lg border border-status-processing-text/40 bg-status-processing-bg px-3 py-2.5">
							{editing ? (
								<Input
									value={draft.stopForOperator}
									onChange={(e) => onDraftChange({ ...draft, stopForOperator: e.target.value })}
									className="h-8 text-sm"
									aria-label="Stop for operator"
								/>
							) : (
								<p className="text-xs leading-relaxed text-status-processing-text">
									{plan.stopForOperator}
								</p>
							)}
						</div>
					</section>
				)}
			</div>

			<div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted px-5 py-3 pb-[calc(0.75rem_+_env(safe-area-inset-bottom))] md:pb-3">
				{created ? (
					<>
						<Button size="sm" className="min-h-11 md:min-h-9" asChild>
							<Link
								to="/$workspaceId/loops/$loopId"
								params={{ workspaceId, loopId: createdId ?? '' }}
							>
								Open loop
							</Link>
						</Button>
						<Button size="sm" variant="ghost" className="min-h-11 md:min-h-9" onClick={onDone}>
							Done
						</Button>
					</>
				) : editing ? (
					<>
						<Button size="sm" className="min-h-11 md:min-h-9" onClick={onSave}>
							Save
						</Button>
						<Button
							size="sm"
							variant="ghost"
							className="min-h-11 md:min-h-9"
							onClick={onDone}
							disabled={creating}
						>
							Done
						</Button>
					</>
				) : (
					<>
						<span className="mr-auto text-[11px] text-muted-foreground">
							Nothing is created until you press Create loop.
						</span>
						<Button size="sm" variant="ghost" className="min-h-11 md:min-h-9" onClick={onAdjust}>
							Adjust
						</Button>
						<Button
							size="sm"
							className="min-h-11 md:min-h-9"
							onClick={onCreate}
							disabled={creating}
						>
							{creating ? (
								'Creating…'
							) : (
								<>
									<Plus size={14} className="mr-1" aria-hidden />
									Create loop
								</>
							)}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							className="min-h-11 md:min-h-9"
							onClick={onDone}
							disabled={creating}
						>
							Done
						</Button>
					</>
				)}
			</div>
		</div>
	)
}
