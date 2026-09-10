import { ActorAvatar } from '@/components/shared/actor-avatar'
import { trackLoopsDetailFlowScrollDepth } from '@/lib/analytics'
import type { LoopStep, LoopSummary } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useEffect, useRef } from 'react'

/**
 * Vertical-story renderer for `LoopFlow` (Loops v4 / D6c) — the "what does
 * this loop do" answer on the loop-detail route. Reads `loop.steps[]` (the
 * `LoopStep[]` returned by `GET /api/loops/:id/steps`) as a spine of
 * six-step-kind rows:
 *
 *   TRIGGER · FIRES → PICKS UP → HANDS OFF → PUBLISHES → DONE WHEN → ESCALATES TO
 *
 * The default (`status-columns`) LoopFlow variant stays for marketplace /
 * admin views. This renderer only ships on `/loops/:id`, gated behind the
 * `loops-v4-polish.step_flow` sub-flag at the route level (see
 * `apps/web/src/routes/_authed/$workspaceId/loops/$loopId.tsx`).
 *
 * PostHog: emits `loops.detail.flow_scroll_depth` with
 * `{depth: 25|50|75|100, loopId}` at each threshold, once per depth per mount,
 * so the parent bet's Won-condition "one-scroll read" metric can be measured.
 */

interface LoopFlowVerticalStoryProps {
	loop: LoopSummary
	steps: LoopStep[]
}

// The six mono-eyebrow step-kind labels the SPEC pins verbatim. Kept here as
// a single constant so a reviewer can eyeball the copy list against the SPEC
// without hunting through the render tree.
const STEP_KIND_LABELS = {
	trigger: 'TRIGGER · FIRES',
	picksUp: 'PICKS UP',
	handsOff: 'HANDS OFF',
	publishes: 'PUBLISHES',
	doneWhen: 'DONE WHEN',
	escalatesTo: 'ESCALATES TO',
} as const

/** Human-friendly duration rendering for the ESCALATES TO threshold. Uses
 * floor-per-unit (not round) so the SPEC-pattern `if pending > 12h → Sebk`
 * renders `12h` for a 12-hour threshold — round-to-day would flip it to `1d`
 * because 12h/day rounds up. Only promotes to the next unit when a whole one
 * has passed, which is what a reader expects on an escalation threshold that
 * came from a configured integer. */
function formatEscalationThreshold(ms: number | null | undefined): string | null {
	if (!ms || ms <= 0 || !Number.isFinite(ms)) return null
	const days = Math.floor(ms / (24 * 60 * 60 * 1000))
	if (days >= 1) return `${days}d`
	const hours = Math.floor(ms / (60 * 60 * 1000))
	if (hours >= 1) return `${hours}h`
	return `${Math.max(1, Math.floor(ms / (60 * 1000)))}m`
}

/** Cron / event / reminder description for the TRIGGER · FIRES row. Falls back
 * to the trigger's own name when the config is empty or the type isn't
 * recognised, so a hand-crafted trigger row never renders an empty eyebrow. */
function formatTriggerDescription(step: LoopStep): string {
	const config = (step.triggerConfig as Record<string, unknown> | null | undefined) ?? {}
	if (step.triggerType === 'cron') {
		const expr = typeof config.expression === 'string' ? config.expression : null
		if (expr) return `on schedule ${expr}`
		return 'on schedule'
	}
	if (step.triggerType === 'event') {
		const entityType = typeof config.entity_type === 'string' ? config.entity_type : null
		const action = typeof config.action === 'string' ? config.action : null
		if (entityType && action) return `when ${entityType} ${action}`
		if (action) return `when ${action}`
		return 'on event'
	}
	if (step.triggerType === 'reminder') {
		const scheduledAt = typeof config.scheduled_at === 'string' ? config.scheduled_at : null
		if (scheduledAt) return `once at ${scheduledAt}`
		return 'once'
	}
	return step.triggerName ?? step.triggerType ?? 'on trigger'
}

// Shared row shell: mono eyebrow above content, aligned against the spine
// dot on the left. `dot` is the aria-hidden visual bullet — semantics live in
// the eyebrow text, matching the a11y contract in the SPEC.
function SpineRow({
	label,
	dot,
	children,
	dotClassName,
}: {
	label: string
	dot: React.ReactNode
	children: React.ReactNode
	dotClassName?: string
}) {
	return (
		<div className="flex items-start gap-3">
			<div aria-hidden="true" className={cn('mt-1.5 flex-shrink-0', dotClassName)}>
				{dot}
			</div>
			<div className="min-w-0 flex-1">
				<div className="eyebrow">{label}</div>
				<div className="mt-1 text-[13px] leading-relaxed text-foreground">{children}</div>
			</div>
		</div>
	)
}

function PillDot({ className }: { className?: string }) {
	// Reuses the shipped 2s ease-in-out pulse (Tailwind `animate-pulse`) — same
	// `.pill-dot` motion the loop-detail state pill uses in the header, so
	// live-state signalling is consistent across the page.
	return <span className={cn('block h-2 w-2 rounded-full', className)} />
}

function EmptySpine() {
	return (
		<div className="flex items-start gap-3">
			<div aria-hidden="true" className="mt-1.5 flex-shrink-0">
				<span className="block h-2 w-2 rounded-full border border-dashed border-muted-foreground bg-transparent" />
			</div>
			<div className="min-w-0 flex-1">
				<p className="text-[13px] leading-relaxed text-muted-foreground">
					No steps yet — describe one below
				</p>
			</div>
		</div>
	)
}

export function LoopFlowVerticalStory({ loop, steps }: LoopFlowVerticalStoryProps) {
	const containerRef = useRef<HTMLDivElement>(null)
	const emittedDepthsRef = useRef<Set<number>>(new Set())

	// PostHog `loops.detail.flow_scroll_depth`. Fires at 25/50/75/100 as the
	// user scrolls the spine into view — measured from the container's top vs.
	// the viewport, not the whole page, so it isolates the vertical-story
	// engagement signal from other scroll events on the detail route.
	useEffect(() => {
		const node = containerRef.current
		if (!node) return
		const DEPTHS: Array<25 | 50 | 75 | 100> = [25, 50, 75, 100]
		const emitted = emittedDepthsRef.current

		function onScroll() {
			if (!node) return
			const rect = node.getBoundingClientRect()
			const viewport = window.innerHeight || document.documentElement.clientHeight
			// How far the container has scrolled UP relative to the viewport
			// height. 0 = top-of-container just entered from below, 1 =
			// bottom-of-container has passed the top of the viewport.
			const scrolled = viewport - rect.top
			const total = rect.height + viewport
			if (total <= 0) return
			const ratio = Math.max(0, Math.min(1, scrolled / total))
			for (const depth of DEPTHS) {
				if (ratio * 100 >= depth && !emitted.has(depth)) {
					emitted.add(depth)
					trackLoopsDetailFlowScrollDepth({ depth, loopId: loop.id })
				}
			}
		}

		window.addEventListener('scroll', onScroll, { passive: true })
		// Also check on mount — a short spine may already be fully in view.
		onScroll()
		return () => window.removeEventListener('scroll', onScroll)
	}, [loop.id])

	if (steps.length === 0) {
		return (
			<div ref={containerRef} id="loop-flow" data-loop-flow-root>
				<div className="mb-3">
					<h2 className="text-sm font-semibold text-foreground">The loop, right now</h2>
				</div>
				<div className="border border-border rounded-xl bg-card p-4 shadow-sm">
					<EmptySpine />
				</div>
			</div>
		)
	}

	return (
		<div ref={containerRef} id="loop-flow" data-loop-flow-root>
			<div className="mb-3">
				<h2 className="text-sm font-semibold text-foreground">The loop, right now</h2>
			</div>
			<div className="border border-border rounded-xl bg-card p-4 shadow-sm flex flex-col gap-5">
				{steps.map((step, index) => {
					const isFirst = index === 0
					const agentName = step.agent?.name ?? 'Unknown agent'
					const handsOffName = step.handsOffToActor?.name ?? 'you'
					const escalationThreshold = formatEscalationThreshold(step.escalateAfterMs)
					const escalatesToName = step.escalatesToActor?.name ?? null

					return (
						<div
							key={step.triggerId}
							className="flex flex-col gap-3"
							data-testid={`loop-step-${step.triggerId}`}
						>
							{isFirst && (
								<SpineRow
									label={STEP_KIND_LABELS.trigger}
									dot={<PillDot className="bg-primary animate-pulse" />}
								>
									<span className="text-muted-foreground">{formatTriggerDescription(step)}</span>
								</SpineRow>
							)}

							<SpineRow
								label={isFirst ? STEP_KIND_LABELS.picksUp : STEP_KIND_LABELS.publishes}
								dot={<PillDot className="bg-primary" />}
							>
								<div className="flex items-start gap-2">
									{step.agent && (
										<ActorAvatar
											id={step.agent.id}
											name={agentName}
											type="agent"
											className="mt-0.5"
										/>
									)}
									<div className="min-w-0 flex-1">
										<span className="font-semibold text-foreground">{agentName}</span>{' '}
										<span className="text-muted-foreground">
											{step.triggerActionPrompt ?? step.triggerName ?? ''}
										</span>
									</div>
								</div>
							</SpineRow>

							{step.handsOffToActorId && (
								<SpineRow
									label={STEP_KIND_LABELS.handsOff}
									dot={
										<PillDot
											className={cn(
												step.waitingOnViewer ? 'bg-warning animate-pulse' : 'bg-muted-foreground',
											)}
										/>
									}
								>
									<div className="flex items-center gap-2">
										{step.handsOffToActor && (
											<ActorAvatar id={step.handsOffToActor.id} name={handsOffName} type="agent" />
										)}
										<span className="font-semibold text-foreground">{handsOffName}</span>
										{step.waitingOnViewer && step.pendingCount > 0 && (
											<span className="inline-flex items-center rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-semibold text-accent-foreground">
												{step.pendingCount} pending
											</span>
										)}
									</div>
								</SpineRow>
							)}

							{step.escalatesToActorId && escalationThreshold && (
								<SpineRow
									label={STEP_KIND_LABELS.escalatesTo}
									dot={<PillDot className="bg-error" />}
								>
									<span className="text-muted-foreground">
										if pending &gt; {escalationThreshold} →{' '}
										<span className="font-semibold text-foreground">
											{escalatesToName ?? 'unknown'}
										</span>
									</span>
								</SpineRow>
							)}
						</div>
					)
				})}

				{loop.closeCondition && (
					<SpineRow
						label={STEP_KIND_LABELS.doneWhen}
						dot={<PillDot className="bg-muted-foreground" />}
					>
						<span className="text-foreground/85">{loop.closeCondition}</span>
					</SpineRow>
				)}
			</div>
		</div>
	)
}
