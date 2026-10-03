import { Spinner } from '@/components/ui/spinner'
import type { SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDurationBetween } from '@/lib/format-duration'
import { CheckCircle2, Clock, PauseCircle, XCircle } from 'lucide-react'

/**
 * S2 · Spawn indicator (bet 34706e2f, task 5) — the persistent marker on any
 * chat message that spawned an agent session.
 *
 * Two pieces:
 *  - a vertical `--brand` bar to the right of the message bubble (`w-1 h-full`)
 *    rendered inline by MessageBubble
 *  - a spawn chip below the bubble reading "Session started · <duration> ·
 *    <status>"
 *
 * Independent of Task 4's deep-link 2.2s pulse — that lives inside the
 * `<Origin>` block flow and only fires when the reader clicks
 * "Open chat at this moment". This indicator is always on so a reader
 * scrolling the transcript can spot the messages that triggered work.
 */
export interface MessageSpawnInfo {
	sessionId: string
	status: string
	startedAt: string | null
	completedAt: string | null
}

/**
 * Given the sessions returned by `useActiveSessionsForConversation`, builds
 * `messageId → session` for the messages that spawned each one. Reads the
 * spawning message id off `session.config.conversation.message_id` — the same
 * field the conversation-responder writes at spawn time and the same value
 * Task 3 persists on the `spawned` edge's `metadata.messageId`. Sessions with
 * no spawning message (e.g. an autonomous cron-triggered session that later
 * posted into a chat) are skipped — the acceptance criteria's shape is one
 * bar per triggering message, so a session with no anchor has nowhere to sit.
 */
export function deriveMessageSpawnMap(sessions: SessionResponse[]): Map<number, MessageSpawnInfo> {
	const map = new Map<number, MessageSpawnInfo>()
	for (const session of sessions) {
		const config = session.config as { conversation?: { message_id?: unknown } } | null | undefined
		const raw = config?.conversation?.message_id
		const messageId = typeof raw === 'number' ? raw : Number(raw)
		if (!Number.isFinite(messageId) || messageId <= 0) continue
		// If two sessions were spawned from the same message (a rare race where
		// two agents both responded), keep the earliest — the reader is more
		// likely to have that context on screen, and the chip is a summary
		// glance, not a session list.
		const existing = map.get(messageId)
		if (existing) {
			const existingStart = existing.startedAt ?? ''
			const nextStart = session.startedAt ?? ''
			if (existingStart && nextStart && existingStart <= nextStart) continue
		}
		map.set(messageId, {
			sessionId: session.id,
			status: session.status,
			startedAt: session.startedAt,
			completedAt: session.completedAt,
		})
	}
	return map
}

const STATUS_ICON: Record<string, React.ElementType> = {
	completed: CheckCircle2,
	failed: XCircle,
	timeout: XCircle,
	paused: PauseCircle,
	waiting_for_input: Clock,
}

const STATUS_LABEL: Record<string, string> = {
	pending: 'starting',
	starting: 'starting',
	queued: 'starting',
	snapshotting: 'running',
	running: 'running',
	completed: 'completed',
	failed: 'failed',
	timeout: 'timed out',
	paused: 'paused',
	waiting_for_input: 'waiting',
}

function statusLabel(status: string): string {
	return STATUS_LABEL[status] ?? status
}

export function SpawnChip({ info, className }: { info: MessageSpawnInfo; className?: string }) {
	const duration = formatDurationBetween(info.startedAt, info.completedAt)
	const Icon = STATUS_ICON[info.status] ?? Spinner
	const isRunning =
		info.status === 'running' ||
		info.status === 'starting' ||
		info.status === 'pending' ||
		info.status === 'queued' ||
		info.status === 'snapshotting'
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-sunken px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground',
				className,
			)}
			data-testid="spawn-chip"
		>
			{isRunning ? (
				<Spinner className="size-3 text-muted-foreground" />
			) : (
				<Icon size={11} aria-hidden className="text-muted-foreground" />
			)}
			<span>
				Session started
				{duration ? <> · {duration}</> : null}
				{' · '}
				{statusLabel(info.status)}
			</span>
		</span>
	)
}

/**
 * Persistent vertical --brand bar rendered to the right of the message bubble.
 * `w-1 h-full` per the acceptance criteria; sits inside the bubble's flex row
 * so it self-aligns with the bubble height. Purely decorative — screen-reader
 * users hear the spawn chip's caption below the bubble.
 */
export function SpawnBar({ className }: { className?: string }) {
	return (
		<span
			aria-hidden="true"
			data-testid="spawn-bar"
			className={cn('block h-full w-1 shrink-0 self-stretch rounded-full bg-brand', className)}
		/>
	)
}
