import { CommentInput } from '@/components/activity/comment-input'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import type { NotificationResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { DECISION_REVERSE_WINDOW_MS } from '@/lib/foryou-decision'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, CheckIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

// One decision option surfaced in the amber decision block. Mirrors the shape
// of `notificationOptionSchema` from `@maskin/shared` (label + value, optional
// description), with an additional `tone` hint the renderer uses to pick the
// primary vs. secondary button style. The dispatcher (T5) is expected to fill
// this by mapping `notification.metadata.options[]` with tone derived from the
// option's `default` marker.
export interface PostRendererOption {
	label: string
	value: string
	description?: string
	tone?: 'primary' | 'secondary'
}

// Post/comment-shaped metadata pulled from the referenced object. Optional so
// the renderer stays usable even when the caller only has the notification.
export interface PostRendererObjectRef {
	type?: string
	status?: string
	title?: string
}

export interface PostRendererProps {
	workspaceId: string
	notification: NotificationResponse
	options: readonly PostRendererOption[]
	// The referenced object the post lives on. Falls back to notification.title
	// when no explicit reference is provided.
	post?: PostRendererObjectRef
	// Fires once the reverse window elapses without a reverse — the caller
	// posts the actual response (via bulk-respond or per-id respond).
	onCommit?: (option: PostRendererOption) => void
	// Fires when the user reverses inside the window — caller can clean up
	// optimistic state.
	onReverse?: () => void
}

type DecisionPhase =
	| { status: 'idle' }
	| { status: 'receipt'; option: PostRendererOption; deadline: number }
	| { status: 'committed'; option: PostRendererOption }

export function PostRenderer({
	workspaceId,
	notification,
	options,
	post,
	onCommit,
	onReverse,
}: PostRendererProps) {
	const objectId = notification.objectId
	const title = post?.title ?? notification.title
	const summary = notification.content?.trim() ?? ''
	const objectType = post?.type ?? 'post'
	const objectStatus = post?.status

	const [phase, setPhase] = useState<DecisionPhase>({ status: 'idle' })
	const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	useEffect(
		() => () => {
			if (commitTimer.current) clearTimeout(commitTimer.current)
		},
		[],
	)

	const chooseOption = useCallback(
		(option: PostRendererOption) => {
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
			data-testid="foryou-post-renderer"
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

			{/* Summary strip */}
			{summary && (
				<div className="border-b border-border bg-secondary/25 px-4 py-2.5">
					<p className="text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground">
						✦ Summary
					</p>
					<p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">
						{summary}
					</p>
				</div>
			)}

			{/* Contextual link back to the referenced post */}
			{objectId && (
				<div className="border-b border-border px-4 py-2 text-xs">
					<Link
						to="/$workspaceId/objects/$objectId"
						params={{ workspaceId, objectId }}
						className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground hover:underline"
					>
						View post <ArrowUpRight className="h-3 w-3" />
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
