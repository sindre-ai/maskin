import { CommentInput } from '@/components/activity/comment-input'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import type { NotificationResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { DECISION_REVERSE_WINDOW_MS } from '@/lib/foryou-decision'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, CheckIcon, FileDiff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

// Same shape as PostRenderer's option — the dispatcher fills this from
// `notification.metadata.options[]`. Kept per-renderer so each surface can
// evolve independently without churning a shared type.
export interface DiffRendererOption {
	label: string
	value: string
	description?: string
	tone?: 'primary' | 'secondary'
}

// One line of a unified diff. `kind` drives the row's semantic token pair —
// `added` uses green `--st-active-*`, `removed` uses red `--st-blocked-*`, and
// `context` sits on the neutral surface. Line numbers are optional so callers
// that only have the raw hunk still render.
export interface DiffRendererLine {
	kind: 'added' | 'removed' | 'context'
	text: string
	oldLineNumber?: number
	newLineNumber?: number
}

// Compact diff payload the renderer expects. The dispatcher builds this from
// `notification.metadata.artifacts[]` (kind === 'diff' + fileId + title) plus
// the file body — the shape lives here so the renderer stays testable in
// isolation.
export interface DiffRendererDiff {
	filePath: string
	// Optional — falls back to the file path if omitted.
	title?: string
	lines: readonly DiffRendererLine[]
	// Referenced object the diff belongs to (a PR, a task, a session). Optional
	// so the renderer stays usable when the caller only has the notification.
	object?: {
		type?: string
		status?: string
	}
}

export interface DiffRendererProps {
	workspaceId: string
	notification: NotificationResponse
	options: readonly DiffRendererOption[]
	diff: DiffRendererDiff
	// Fires once the reverse window elapses without a reverse — the caller
	// posts the actual response (via bulk-respond or per-id respond).
	onCommit?: (option: DiffRendererOption) => void
	// Fires when the user reverses inside the window — caller can clean up
	// optimistic state.
	onReverse?: () => void
}

type DecisionPhase =
	| { status: 'idle' }
	| { status: 'receipt'; option: DiffRendererOption; deadline: number }
	| { status: 'committed'; option: DiffRendererOption }

// Cap on visible diff lines. Beyond this we render a "+N more" footer so the
// card stays scannable at the ship-gate viewports (375 / 768 / 1024).
const MAX_VISIBLE_LINES = 8

export function DiffRenderer({
	workspaceId,
	notification,
	options,
	diff,
	onCommit,
	onReverse,
}: DiffRendererProps) {
	const objectId = notification.objectId
	const title = diff.title ?? diff.filePath
	const objectType = diff.object?.type ?? 'diff'
	const objectStatus = diff.object?.status

	const visibleLines = diff.lines.slice(0, MAX_VISIBLE_LINES)
	const overflowCount = Math.max(0, diff.lines.length - MAX_VISIBLE_LINES)
	const addedCount = diff.lines.filter((line) => line.kind === 'added').length
	const removedCount = diff.lines.filter((line) => line.kind === 'removed').length

	const [phase, setPhase] = useState<DecisionPhase>({ status: 'idle' })
	const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	useEffect(
		() => () => {
			if (commitTimer.current) clearTimeout(commitTimer.current)
		},
		[],
	)

	const chooseOption = useCallback(
		(option: DiffRendererOption) => {
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

	// Live countdown for the receipt's "Reversible for Ns" label.
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
			data-testid="foryou-diff-renderer"
			className="flex h-full w-full flex-col overflow-hidden rounded-[18px] border border-border bg-background shadow-md"
		>
			{/* Header */}
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

			{/* Diff panel */}
			<div className="border-b border-border">
				<div className="flex items-center justify-between gap-3 border-b border-border bg-secondary/25 px-4 py-2">
					<div className="flex min-w-0 items-center gap-2">
						<FileDiff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						<span
							data-testid="foryou-diff-file-path"
							className="truncate font-mono text-[12px] text-foreground"
							title={diff.filePath}
						>
							{diff.filePath}
						</span>
					</div>
					<div className="flex shrink-0 items-center gap-2 font-mono text-[11px]">
						<span className="text-status-active-text">+{addedCount}</span>
						<span className="text-status-blocked-text">-{removedCount}</span>
					</div>
				</div>
				<ol
					data-testid="foryou-diff-lines"
					className="max-h-56 divide-y divide-border/50 overflow-y-auto bg-background"
				>
					{visibleLines.map((line, index) => (
						<li
							key={`${line.kind}-${index}-${line.oldLineNumber ?? ''}-${line.newLineNumber ?? ''}`}
							data-testid={`foryou-diff-line-${line.kind}`}
							className={cn(
								'flex items-start gap-2 px-4 py-1 font-mono text-[12px] leading-snug',
								line.kind === 'added' && 'bg-status-active-bg text-status-active-text',
								line.kind === 'removed' && 'bg-status-blocked-bg text-status-blocked-text',
								line.kind === 'context' && 'text-muted-foreground',
							)}
						>
							<span aria-hidden="true" className="w-3 shrink-0 select-none text-[11px] opacity-70">
								{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
							</span>
							<span className="w-16 shrink-0 select-none text-right text-[10.5px] opacity-60">
								{line.oldLineNumber ?? ''}
								{line.oldLineNumber !== undefined && line.newLineNumber !== undefined ? ' ' : ''}
								{line.newLineNumber ?? ''}
							</span>
							<span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{line.text}</span>
						</li>
					))}
				</ol>
				{overflowCount > 0 && (
					<div
						data-testid="foryou-diff-overflow"
						className="border-t border-border bg-secondary/25 px-4 py-1.5 text-center font-mono text-[11px] text-muted-foreground"
					>
						+{overflowCount} more {overflowCount === 1 ? 'line' : 'lines'}
					</div>
				)}
			</div>

			{/* Contextual link back to the referenced object */}
			{objectId && (
				<div className="border-b border-border px-4 py-2 text-xs">
					<Link
						to="/$workspaceId/objects/$objectId"
						params={{ workspaceId, objectId }}
						className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground hover:underline"
					>
						View diff <ArrowUpRight className="h-3 w-3" />
					</Link>
				</div>
			)}

			{/* Footer: decision → receipt → committed */}
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
