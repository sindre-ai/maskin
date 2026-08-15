import { CommentInput } from '@/components/activity/comment-input'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import type { NotificationResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { DECISION_REVERSE_WINDOW_MS } from '@/lib/foryou-decision'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, CheckIcon, Minus, TrendingDown, TrendingUp } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface MetricRendererOption {
	label: string
	value: string
	description?: string
	tone?: 'primary' | 'secondary'
}

// Trend direction for the plotted metric. Colour follows the arrow:
// up → success, down → error, flat → muted. Callers whose metric is
// "lower is better" (churn, cost, latency) should invert their upstream
// mapping before passing — the renderer stays domain-agnostic.
export type MetricTrend = 'up' | 'down' | 'flat'

// Metric payload rendered in the card body. All fields optional so the
// renderer stays usable when the caller only has the notification (falls
// back to notification title/content).
export interface MetricRendererMetric {
	// Formatted value string, e.g. "1,247", "12.5%", "$4.2k". The renderer
	// does not format numbers — the caller controls locale and precision.
	value?: string
	label?: string
	unit?: string
	trend?: MetricTrend
	// Formatted delta, e.g. "+18%", "−340", "flat vs last week".
	delta?: string
	// Optional referenced object shape mirroring PostRenderer's `post?` prop.
	type?: string
	status?: string
	title?: string
}

export interface MetricRendererProps {
	workspaceId: string
	notification: NotificationResponse
	options: readonly MetricRendererOption[]
	metric?: MetricRendererMetric
	onCommit?: (option: MetricRendererOption) => void
	onReverse?: () => void
}

type DecisionPhase =
	| { status: 'idle' }
	| { status: 'receipt'; option: MetricRendererOption; deadline: number }
	| { status: 'committed'; option: MetricRendererOption }

const TREND_ICON: Record<MetricTrend, typeof TrendingUp> = {
	up: TrendingUp,
	down: TrendingDown,
	flat: Minus,
}

const TREND_COLOUR: Record<MetricTrend, string> = {
	up: 'text-success',
	down: 'text-error',
	flat: 'text-muted-foreground',
}

const TREND_LABEL: Record<MetricTrend, string> = {
	up: 'Trending up',
	down: 'Trending down',
	flat: 'Flat',
}

export function MetricRenderer({
	workspaceId,
	notification,
	options,
	metric,
	onCommit,
	onReverse,
}: MetricRendererProps) {
	const objectId = notification.objectId
	const title = metric?.title ?? notification.title
	const summary = notification.content?.trim() ?? ''
	const objectType = metric?.type ?? 'metric'
	const objectStatus = metric?.status
	const trend: MetricTrend = metric?.trend ?? 'flat'
	const TrendIcon = TREND_ICON[trend]
	const metricValue = metric?.value ?? ''
	const metricLabel = metric?.label ?? ''
	const metricUnit = metric?.unit ?? ''
	const metricDelta = metric?.delta ?? ''

	const [phase, setPhase] = useState<DecisionPhase>({ status: 'idle' })
	const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	useEffect(
		() => () => {
			if (commitTimer.current) clearTimeout(commitTimer.current)
		},
		[],
	)

	const chooseOption = useCallback(
		(option: MetricRendererOption) => {
			setPhase({
				status: 'receipt',
				option,
				deadline: Date.now() + DECISION_REVERSE_WINDOW_MS,
			})
			commitTimer.current = setTimeout(() => {
				setPhase({ status: 'committed', option })
				onCommit?.(option)
			}, DECISION_REVERSE_WINDOW_MS)
		},
		[onCommit],
	)

	const reverseChoice = useCallback(() => {
		if (commitTimer.current) {
			clearTimeout(commitTimer.current)
			commitTimer.current = null
		}
		setPhase({ status: 'idle' })
		onReverse?.()
	}, [onReverse])

	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (phase.status !== 'receipt') return
		const interval = setInterval(() => setNow(Date.now()), 250)
		return () => clearInterval(interval)
	}, [phase.status])
	const secondsLeft =
		phase.status === 'receipt' ? Math.max(0, Math.ceil((phase.deadline - now) / 1000)) : 0

	return (
		<div
			data-testid="foryou-metric-renderer"
			className="flex h-full w-full flex-col overflow-hidden rounded-[18px] border border-border bg-background shadow-md"
		>
			<div className="flex items-start gap-3 border-b border-border px-4 py-3">
				<TypeBadge type={objectType} />
				<div className="min-w-0 flex-1">
					{objectId ? (
						<Link
							to="/$workspaceId/objects/$objectId"
							params={{ workspaceId, objectId }}
							className="block truncate text-[15px] font-semibold leading-snug text-foreground hover:underline"
							title={title}
						>
							{title}
						</Link>
					) : (
						<span
							className="block truncate text-[15px] font-semibold leading-snug text-foreground"
							title={title}
						>
							{title}
						</span>
					)}
					{objectStatus && (
						<div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
							<StatusBadge status={objectStatus} variant="dot-word" />
						</div>
					)}
				</div>
				{objectId && (
					<Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" asChild>
						<Link to="/$workspaceId/objects/$objectId" params={{ workspaceId, objectId }}>
							Open <ArrowUpRight className="ml-1 h-3 w-3" />
						</Link>
					</Button>
				)}
			</div>

			<div
				className="border-b border-border bg-secondary/25 px-4 py-3"
				data-testid="foryou-metric-body"
			>
				<div className="flex items-baseline gap-2">
					<span
						className="font-mono text-2xl font-semibold leading-none tabular-nums text-foreground"
						data-testid="foryou-metric-value"
					>
						{metricValue || '—'}
					</span>
					{metricUnit && (
						<span className="text-sm font-medium text-muted-foreground">{metricUnit}</span>
					)}
				</div>
				{metricLabel && (
					<p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{metricLabel}</p>
				)}
				<div
					className={cn(
						'mt-2 flex items-center gap-1.5 text-[12px] font-medium',
						TREND_COLOUR[trend],
					)}
					data-testid="foryou-metric-trend"
					data-trend={trend}
				>
					<TrendIcon className="h-3.5 w-3.5" aria-hidden="true" />
					<span className="sr-only">{TREND_LABEL[trend]}</span>
					{metricDelta && <span>{metricDelta}</span>}
				</div>
			</div>

			{summary && (
				<div className="border-b border-border px-4 py-2.5">
					<p className="text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground">
						✦ Summary
					</p>
					<p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">
						{summary}
					</p>
				</div>
			)}

			<div className="mt-auto shrink-0 border-t border-border bg-background px-4 py-3">
				{phase.status === 'idle' && options.length > 0 && (
					<div
						data-testid="decision-block"
						className="mb-3 rounded-md bg-status-in_review-bg p-2.5"
					>
						<div className="flex items-center gap-2 px-1 pb-2">
							<span
								data-testid="waiting-on-you-indicator"
								className="text-[12px] font-semibold text-status-in_review-text"
							>
								Waiting on you
							</span>
						</div>
						<div className="flex flex-col gap-1.5">
							{options.map((option) => (
								<button
									key={option.value}
									type="button"
									data-action-id={option.value}
									className={cn(
										'flex min-h-12 w-full touch-manipulation items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-[13.5px] font-medium transition-colors',
										option.tone === 'primary'
											? 'bg-foreground text-background hover:bg-foreground/90'
											: 'border border-border bg-background text-foreground hover:bg-secondary',
									)}
									onClick={() => chooseOption(option)}
								>
									<span className="flex min-w-0 flex-col">
										<span className="truncate">{option.label}</span>
										{option.description && (
											<span
												className={cn(
													'truncate text-[11px] font-normal',
													option.tone === 'primary'
														? 'text-background/70'
														: 'text-muted-foreground',
												)}
											>
												{option.description}
											</span>
										)}
									</span>
									{option.tone === 'primary' && (
										<kbd className="shrink-0 rounded border border-current px-1.5 py-0.5 font-mono text-[10px] opacity-70">
											↵
										</kbd>
									)}
								</button>
							))}
						</div>
					</div>
				)}

				{(phase.status === 'receipt' || phase.status === 'committed') && (
					<div
						data-testid="decision-receipt"
						className="mb-3 rounded-md border border-border bg-status-active-bg p-3"
					>
						<div className="flex items-center gap-2 text-sm font-medium text-status-active-text">
							<CheckIcon size={14} />
							You chose {phase.option.label}
						</div>
						{phase.status === 'committed' ? (
							<div className="mt-2 space-y-1 border-t border-status-active-text/20 pt-2 text-xs text-status-active-text/80">
								<p className="flex items-center gap-1.5">
									<CheckIcon size={12} />
									Your choice was posted to the thread
								</p>
							</div>
						) : (
							<div className="mt-2 flex items-center justify-between gap-2">
								<Button
									size="sm"
									variant="outline"
									className="h-7 bg-background text-xs"
									onClick={reverseChoice}
								>
									Reverse this
								</Button>
								<span className="text-xs text-muted-foreground">Reversible for {secondsLeft}s</span>
							</div>
						)}
					</div>
				)}

				{objectId && (
					<CommentInput
						workspaceId={workspaceId}
						objectId={objectId}
						mentionDropdownPlacement="above"
					/>
				)}
			</div>
		</div>
	)
}
