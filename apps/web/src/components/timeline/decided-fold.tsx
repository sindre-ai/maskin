import { ActivityComment } from '@/components/activity/activity-comment'
import type { EventResponse } from '@/lib/api'
import { decisionOfEvent } from '@/lib/comment-decision'
import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

const FOLD_STORAGE_PREFIX = 'timeline-decided-fold:'

/** Whether a decision comment has been resolved by any reply naming an option. */
export function findDecisionAnswer(
	event: EventResponse,
	replies: EventResponse[],
): EventResponse | null {
	const decision = decisionOfEvent(event)
	if (!decision) return null
	const labels = new Set(decision.options.map((option) => option.label.toLowerCase()))
	return (
		replies.find((reply) => {
			const content = reply.data?.content
			return typeof content === 'string' && labels.has(content.trim().toLowerCase())
		}) ?? null
	)
}

/**
 * `true` when the decision on `event` has an answer reply older than one hour.
 * Recently-resolved decisions (< 1h) stay expanded so the reader still sees the
 * card and its answer inline; anything older folds by default.
 */
export function isDecidedFoldEligible(
	event: EventResponse,
	replies: EventResponse[],
	now: number = Date.now(),
): boolean {
	const answer = findDecisionAnswer(event, replies)
	if (!answer?.createdAt) return false
	const answeredAt = Date.parse(answer.createdAt)
	if (Number.isNaN(answeredAt)) return false
	return now - answeredAt >= 60 * 60 * 1000
}

function firstClauseOf(summary: string): string {
	const trimmed = summary.trim()
	if (!trimmed) return ''
	const match = trimmed.match(/^([^.!?]+[.!?])/)
	return (match ? match[1] : trimmed).trim()
}

function readStoredFold(key: string): boolean {
	if (typeof window === 'undefined') return true
	try {
		const stored = window.localStorage.getItem(key)
		if (stored === 'open') return false
		return true
	} catch {
		return true
	}
}

function writeStoredFold(key: string, folded: boolean) {
	if (typeof window === 'undefined') return
	try {
		if (folded) window.localStorage.removeItem(key)
		else window.localStorage.setItem(key, 'open')
	} catch {
		// localStorage disabled — the fold state simply doesn't persist.
	}
}

/**
 * The collapsed row for a resolved decision (mockup 1234–1249, D9). Renders as
 * `DECIDED · {title} — {summary-first-clause}` with an expand caret; clicking
 * unfolds the row to the full `ActivityComment` (the same renderer the timeline
 * uses for every other comment). Fold state is persisted in `localStorage`,
 * per-decision, as a display preference — client-only is fine here.
 */
export function DecidedFold({
	event,
	replies,
	answer,
	workspaceId,
	objectId,
	isUnread,
}: {
	event: EventResponse
	replies: EventResponse[]
	answer: EventResponse
	workspaceId: string
	objectId: string
	isUnread: boolean
}) {
	const decision = decisionOfEvent(event)
	const storageKey = `${FOLD_STORAGE_PREFIX}${event.id}`
	const [folded, setFolded] = useState(() => readStoredFold(storageKey))

	useEffect(() => {
		writeStoredFold(storageKey, folded)
	}, [folded, storageKey])

	const toggle = useCallback(() => setFolded((prev) => !prev), [])

	if (!decision) return null

	if (!folded) {
		return (
			<div className="relative">
				<button
					type="button"
					onClick={toggle}
					aria-expanded="true"
					className="absolute -top-1 right-0 z-[1] inline-flex h-6 items-center gap-1 rounded-full px-2 text-[10.5px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
				>
					<ChevronDown size={12} aria-hidden="true" className="rotate-180 transition-transform" />
					<span>Fold</span>
				</button>
				<ActivityComment
					event={event}
					replies={replies}
					workspaceId={workspaceId}
					objectId={objectId}
					isUnread={isUnread}
					variant="bubble"
					collapsibleReplies
				/>
			</div>
		)
	}

	const answerText = typeof answer.data?.content === 'string' ? answer.data.content.trim() : ''
	const clause = firstClauseOf(decision.summary)

	return (
		<button
			type="button"
			onClick={toggle}
			aria-expanded="false"
			aria-label={`Expand decided: ${decision.title}`}
			className="group relative flex min-h-[40px] w-full items-center gap-2.5 rounded-md py-2 pl-9 pr-2 text-left transition-colors hover:bg-muted/40"
		>
			<span
				aria-hidden="true"
				className="absolute left-[11px] top-3.5 size-[7px] rounded-full border-2 border-success bg-background"
			/>
			<span className="shrink-0 font-mono text-[9.5px] font-bold uppercase tracking-[0.11em] text-success">
				DECIDED
			</span>
			<span className="min-w-0 flex-1 truncate text-[12.5px] leading-[1.35] text-foreground">
				<span className="font-semibold">{decision.title}</span>
				{clause && (
					<>
						<span className="text-muted-foreground"> — </span>
						<span className="text-muted-foreground">{clause}</span>
					</>
				)}
			</span>
			{answerText && (
				<span className="hidden shrink-0 rounded-full border border-border bg-background px-2 py-[2px] text-[10.5px] font-semibold text-foreground sm:inline">
					{answerText}
				</span>
			)}
			<ChevronDown
				size={12}
				aria-hidden="true"
				className="shrink-0 text-muted-foreground transition-transform group-hover:text-foreground"
			/>
		</button>
	)
}
