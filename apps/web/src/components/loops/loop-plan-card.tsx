import { ActorAvatar } from '@/components/shared/actor-avatar'
import { StatusBadge } from '@/components/shared/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'
import type { LoopPlan } from '@/lib/loop-plan'
import { Link } from '@tanstack/react-router'
import { Check, Lock, Pencil, Plus } from 'lucide-react'

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

function SectionLabel({ children }: { children: string }) {
	return (
		<h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1.5">
			{children}
		</h3>
	)
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

	return (
		<Card className="max-h-[50vh] lg:max-h-[65vh] flex flex-col">
			<CardHeader className="pb-3">
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-2">
						{created ? (
							<Check size={18} className="text-success shrink-0" aria-hidden />
						) : (
							<Lock size={15} className="text-muted-foreground shrink-0" aria-hidden />
						)}
						<CardTitle className="text-base">
							{created ? 'Loop created' : 'PROPOSED LOOP'}
						</CardTitle>
					</div>
					<span
						className={cn(
							'text-[11px] font-medium rounded px-1.5 py-0.5',
							created
								? 'bg-status-live-bg text-status-live-text'
								: 'bg-muted text-muted-foreground',
						)}
					>
						{created ? 'created' : 'not created yet'}
					</span>
				</div>
			</CardHeader>

			<CardContent className="flex-1 overflow-y-auto space-y-4">
				<section>
					<SectionLabel>Object types & state chain</SectionLabel>
					{plan.objectTypes.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No objects detected yet. Describe what should be tracked.
						</p>
					) : (
						plan.objectTypes.map((t, i) => (
							<div key={`${t.type}-${i}`} className="rounded-md border border-border p-3 space-y-2">
								<div className="flex items-center justify-between gap-2">
									{editing && i === 0 ? (
										<Input
											value={draft.objectTypeName}
											onChange={(e) => onDraftChange({ ...draft, objectTypeName: e.target.value })}
											className="h-8 w-44 text-sm"
											aria-label="Object type name"
										/>
									) : (
										<div className="flex items-center gap-2 min-w-0">
											<Badge variant="outline" className="font-medium shrink-0">
												{t.name}
											</Badge>
											<span className="text-sm text-muted-foreground truncate">{t.role}</span>
										</div>
									)}
									{t.live && <Badge variant="outline">tracked live</Badge>}
								</div>
								{editing && i === 0 ? (
									<Input
										value={draft.stateChain.join(', ')}
										onChange={(e) => setStateChain(e.target.value)}
										className="h-8 text-sm"
										placeholder="todo, in_progress, done"
										aria-label="State chain"
									/>
								) : (
									<div className="flex flex-wrap gap-1.5">
										{t.stateChain.map((state) => (
											<StatusBadge key={state} status={state} />
										))}
									</div>
								)}
							</div>
						))
					)}
				</section>

				<section>
					<SectionLabel>Triggers</SectionLabel>
					{plan.triggers.length === 0 ? (
						<p className="text-sm text-muted-foreground">Nothing triggers the loop yet.</p>
					) : (
						<div className="space-y-2">
							{plan.triggers.map((t, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: plan-derived triggers have no stable id and order is deterministic
									key={i}
									className="rounded-md border border-border p-3 text-sm"
								>
									<div className="flex items-center gap-2 mb-1">
										<Badge className="font-medium">{t.kindLabel}</Badge>
										<span className="text-muted-foreground">{t.whenClause}</span>
									</div>
									<p className="text-xs text-muted-foreground">
										{t.targetAgent}{' '}
										{t.thenWrites.map((w) => `${w.act} ${w.type ?? ''}`.trim()).join(' · ')}
										{t.asks ? ` · asks ${t.asks}` : ''}
									</p>
								</div>
							))}
						</div>
					)}
				</section>

				<section>
					<SectionLabel>Agents</SectionLabel>
					{plan.agents.length === 0 ? (
						<p className="text-sm text-muted-foreground">No agents assigned yet.</p>
					) : (
						<div className="space-y-2">
							{plan.agents.map((a, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: plan-derived agents have no stable id and order is deterministic
									key={i}
									className="flex items-center gap-3 rounded-md border border-border p-3"
								>
									<ActorAvatar name={a.name} type="agent" />
									<div className="flex-1 min-w-0">
										{editing && i === 0 ? (
											<Input
												value={draft.agentName}
												onChange={(e) => onDraftChange({ ...draft, agentName: e.target.value })}
												className="h-8 text-sm"
												aria-label="Agent name"
											/>
										) : (
											<p className="text-sm font-medium text-foreground truncate">
												{a.name}
												{a.count > 1 ? ` ×${a.count}` : ''}
											</p>
										)}
										<p className="text-xs text-muted-foreground truncate">{a.role}</p>
									</div>
								</div>
							))}
						</div>
					)}
				</section>

				{plan.stopForOperator && (
					<section>
						<SectionLabel>Stops for you</SectionLabel>
						{editing ? (
							<Input
								value={draft.stopForOperator}
								onChange={(e) => onDraftChange({ ...draft, stopForOperator: e.target.value })}
								className="h-8 text-sm"
								aria-label="Stop for operator"
							/>
						) : (
							<p className="text-sm text-foreground">{plan.stopForOperator}</p>
						)}
					</section>
				)}
			</CardContent>

			<CardFooter className="flex items-center gap-2 flex-wrap pt-3">
				{created ? (
					<>
						<Button size="sm" asChild>
							<Link
								to="/$workspaceId/loops/$loopId"
								params={{ workspaceId, loopId: createdId ?? '' }}
							>
								Open loop
							</Link>
						</Button>
						<Button size="sm" variant="ghost" onClick={onDone}>
							Done
						</Button>
					</>
				) : editing ? (
					<>
						<Button size="sm" onClick={onSave} variant="default">
							Save
						</Button>
						<Button size="sm" variant="ghost" onClick={onDone} disabled={creating}>
							Done
						</Button>
					</>
				) : (
					<>
						<Button size="sm" variant="outline" onClick={onAdjust}>
							<Pencil size={14} className="mr-1" aria-hidden />
							Adjust
						</Button>
						<Button size="sm" onClick={onCreate} disabled={creating}>
							{creating ? (
								'Creating…'
							) : (
								<>
									<Plus size={14} className="mr-1" aria-hidden />
									Create loop
								</>
							)}
						</Button>
						<Button size="sm" variant="ghost" onClick={onDone} disabled={creating}>
							Done
						</Button>
					</>
				)}
			</CardFooter>
		</Card>
	)
}
