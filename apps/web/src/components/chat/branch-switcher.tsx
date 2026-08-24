import { useSwitchBranch } from '@/hooks/use-conversation'
import type { BranchPoint } from '@/lib/api'
import { cn } from '@/lib/cn'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface BranchSwitcherProps {
	workspaceId: string
	conversationId: string
	branchPoint: BranchPoint
	className?: string
}

/**
 * "‹ 2/3 ›" control shown at a message the thread was rewound from.
 *
 * Each option is one version of everything that followed that message: index 0
 * is the original, later indices are re-sends. Switching is server-side state,
 * not a local view toggle — the agents answer on whichever branch is active, so
 * it has to be one choice for the whole conversation, not per-viewer.
 *
 * Deliberately styled as muted text rather than `bg-accent`: `--accent` is a
 * near-white background token in light mode, so using it on a small text-free
 * indicator renders near-invisible there (see .claude/rules/known-pitfalls.md).
 */
export function BranchSwitcher({
	workspaceId,
	conversationId,
	branchPoint,
	className,
}: BranchSwitcherProps) {
	const switchBranch = useSwitchBranch(conversationId, workspaceId)
	const { options, activeIndex } = branchPoint
	const total = options.length

	// A fork point with one option isn't a fork — nothing to switch between.
	if (total < 2) return null

	const go = (nextIndex: number) => {
		const target = options[nextIndex]
		if (!target || nextIndex === activeIndex) return
		switchBranch.mutate({ branchId: target.branchId })
	}

	const atStart = activeIndex <= 0
	const atEnd = activeIndex >= total - 1

	return (
		<div
			className={cn('flex items-center gap-0.5 text-[11px] text-muted-foreground', className)}
			// The chevrons alone read as pagination; name what is being paged.
			aria-label={`Version ${activeIndex + 1} of ${total} of this part of the conversation`}
		>
			<button
				type="button"
				onClick={() => go(activeIndex - 1)}
				disabled={atStart || switchBranch.isPending}
				aria-label="Previous version"
				className="rounded p-0.5 transition-colors hover:text-foreground disabled:opacity-40"
			>
				<ChevronLeft size={12} aria-hidden />
			</button>
			<span className="tabular-nums">
				{activeIndex + 1}/{total}
			</span>
			<button
				type="button"
				onClick={() => go(activeIndex + 1)}
				disabled={atEnd || switchBranch.isPending}
				aria-label="Next version"
				className="rounded p-0.5 transition-colors hover:text-foreground disabled:opacity-40"
			>
				<ChevronRight size={12} aria-hidden />
			</button>
		</div>
	)
}
