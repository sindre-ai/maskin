import { cn } from '@/lib/cn'
import type {
	Capability,
	CapabilityDimension,
	CapabilityGap,
	CapabilityLevel,
} from '@maskin/shared'

const LEVEL_LABEL: Record<CapabilityLevel, string> = {
	novice: 'Novice',
	apprentice: 'Apprentice',
	practitioner: 'Practitioner',
	expert: 'Expert',
	master: 'Master',
}

const LEVEL_PILL_CLASS: Record<CapabilityLevel, string> = {
	novice: 'bg-muted text-muted-foreground',
	apprentice: 'bg-status-in_review-bg text-status-in_review-text',
	practitioner: 'bg-status-in_progress-bg text-status-in_progress-text',
	expert: 'bg-status-active-bg text-status-active-text',
	master: 'bg-status-active-bg text-status-active-text font-semibold',
}

const MAX_DIM_SCORE = 5

export function CapabilityLevelPill({
	level,
	score,
	className,
}: {
	level: CapabilityLevel
	score?: number
	className?: string
}) {
	const label = LEVEL_LABEL[level]
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium leading-none',
				LEVEL_PILL_CLASS[level],
				className,
			)}
			aria-label={
				typeof score === 'number' ? `Capability: ${label}, score ${score}` : `Capability: ${label}`
			}
		>
			<span aria-hidden="true">{label}</span>
			{typeof score === 'number' && (
				<span aria-hidden="true" className="opacity-70">
					· {score}
				</span>
			)}
		</span>
	)
}

export function CapabilityCard({
	capability,
	className,
}: {
	capability: Capability
	className?: string
}) {
	return (
		<section
			className={cn('mb-6', className)}
			aria-labelledby="capability-card-heading"
			data-testid="capability-card"
		>
			<div className="mb-2 flex items-center gap-2">
				<h3
					id="capability-card-heading"
					className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
				>
					Capability
				</h3>
				<CapabilityLevelPill level={capability.overall.level} score={capability.overall.score} />
			</div>

			<div
				className="flex flex-wrap rounded-xl border border-border bg-card overflow-hidden"
				data-testid="capability-tiles"
			>
				{capability.dimensions.map((dim) => (
					<DimensionTile key={dim.key} dimension={dim} />
				))}
			</div>

			{capability.topGaps.length > 0 && (
				<div className="mt-4">
					<div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
						Level up
					</div>
					<ul className="space-y-2" data-testid="capability-level-up">
						{capability.topGaps.map((gap, idx) => (
							<LevelUpItem key={`${gap.dimension}-${idx}`} gap={gap} />
						))}
					</ul>
				</div>
			)}
		</section>
	)
}

function DimensionTile({ dimension }: { dimension: CapabilityDimension }) {
	const reason = dimension.reasons[0] ?? ''
	return (
		<div
			className="flex-1 min-w-[140px] px-4 py-3 border-r border-border last:border-r-0"
			data-testid={`capability-tile-${dimension.key}`}
		>
			<div className="text-xs font-medium text-foreground">{dimension.label}</div>
			<DotRow score={dimension.score} label={`${dimension.label} score`} />
			{reason && (
				<div className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{reason}</div>
			)}
		</div>
	)
}

function DotRow({ score, label }: { score: number; label: string }) {
	const filled = Math.max(0, Math.min(MAX_DIM_SCORE, Math.round(score)))
	return (
		<div
			className="mt-1.5 flex items-center gap-1"
			role="img"
			aria-label={`${label}: ${filled} of ${MAX_DIM_SCORE}`}
		>
			{Array.from({ length: MAX_DIM_SCORE }, (_, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length rubric row
					key={i}
					aria-hidden="true"
					className={cn('h-1.5 w-1.5 rounded-full', i < filled ? 'bg-primary' : 'bg-border')}
				/>
			))}
		</div>
	)
}

function LevelUpItem({ gap }: { gap: CapabilityGap }) {
	return (
		<li className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2">
			<span
				aria-hidden="true"
				className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
			/>
			<div className="min-w-0 flex-1">
				<div className="text-sm text-foreground">{gap.action}</div>
				{gap.detail && <div className="text-xs text-muted-foreground mt-0.5">{gap.detail}</div>}
				{gap.toolHint && (
					<code className="mt-1 inline-block text-[11px] font-mono text-muted-foreground bg-muted rounded px-1.5 py-0.5">
						{gap.toolHint}
					</code>
				)}
			</div>
		</li>
	)
}
