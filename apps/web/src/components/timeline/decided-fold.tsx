import { ActivityComment } from '@/components/activity/activity-comment'
import { RelativeTime } from '@/components/shared/relative-time'
import type { EventResponse } from '@/lib/api'
import { decisionOfEvent } from '@/lib/comment-decision'
import { Check, ChevronDown } from 'lucide-react'
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
 * The collapsed row for a resolved decision (mockup 1234–1249, D9). Renders as a grey
 * `✓ Decided · {title} {answer} · {time}` row with a `Show N comments` control; clicking
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
	focusEventId,
}: {
	event: EventResponse
	replies: EventResponse[]
	answer: EventResponse
	workspaceId: string
	objectId: string
	isUnread: boolean
	/** The comment a `?comment=` link points at; a fold holding it opens. */
	focusEventId?: number
}) {
	const decision = decisionOfEvent(event)
	const storageKey = `${FOLD_STORAGE_PREFIX}${event.id}`
	const holdsFocus =
		focusEventId !== undefined &&
		(event.id === focusEventId || replies.some((r) => r.id === focusEventId))
	const [folded, setFolded] = useState(() => readStoredFold(storageKey) && !holdsFocus)

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
					focusEventId={focusEventId}
				/>
			</div>
		)
	}

	const answerText = typeof answer.data?.content === 'string' ? answer.data.content.trim() : ''
	// The decision comment plus every reply under it.
	const commentCount = 1 + replies.length

	return (
		<button
			type="button"
			onClick={toggle}
			aria-expanded="false"
			aria-label={`Expand decided: ${decision.title}`}
			className="group flex min-h-10 w-full items-center gap-2 rounded-md bg-muted px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/70"
		>
			<Check size={12} aria-hidden="true" className="shrink-0" />
			<span className="shrink-0 font-semibold text-foreground">Decided</span>
			<span className="min-w-0 flex-1 truncate">
				{'· '}
				{answerText ? `${decision.title} ${answerText}` : decision.title}
				{' · '}
				<RelativeTime date={answer.createdAt ?? null} />
			</span>
			<span className="shrink-0 font-semibold group-hover:text-foreground">
				Show {commentCount} {commentCount === 1 ? 'comment' : 'comments'}
			</span>
		</button>
	)
}
