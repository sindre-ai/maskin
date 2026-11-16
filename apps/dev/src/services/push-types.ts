/**
 * Transport-neutral push types. `NotificationPushFanout` builds a `PushMessage` once and hands
 * it to every `PushChannel`; each channel (APNs, Web Push) maps it onto its own wire format and
 * owns its own device table, so one channel failing or being unconfigured never affects another.
 */

export interface PushDecision {
	/** The agent's decision comment (events.id). */
	eventId: number
	/** The comment's own parent, when the decision was posted as a reply. */
	parentEventId?: number | null
	objectId?: string | null
	options: { label: string; destructive?: boolean }[]
	/** Zero-based index into `options` of the recommended choice. */
	recommended?: number | null
}

export type PushInterruption = 'time-sensitive' | 'active' | 'passive'

export interface PushMessage {
	title: string
	body?: string | null
	workspaceId: string
	notificationId: string
	/** The notification's type (needs_input, mention, ...): sent on to the device so an open can be counted by type. */
	notificationType?: string | null
	objectId?: string | null
	conversationId?: string | null
	/** With conversationId: the thread to open inside the chat (the root message id). */
	threadRootId?: number | null
	decision?: PushDecision | null
	/** Banner behaviour: `time-sensitive` breaks through Focus (decisions), `passive` is silent. */
	interruption?: PushInterruption
	/** App-icon badge to show (the actor's pending notifications); omitted leaves it untouched. */
	badge?: number | null
	/** https image the notification service extension downloads and attaches to the banner. */
	imageUrl?: string | null
	/**
	 * A newer push with the same key replaces an older one: becomes `apns-collapse-id` and
	 * `aps.thread-id` (APNs) and the Web Push tag/topic. Defaults to the notification id.
	 */
	collapseKey?: string | null
}

/** At most this many notification ids travel in one clear push. */
export const CLEAR_IDS_MAX = 20

/** A request to take already-delivered pushes off the device: the person handled them elsewhere. */
export interface PushClear {
	workspaceId: string
	/** Notification ids whose pushes to remove (at most `CLEAR_IDS_MAX` per clear). */
	notificationIds: string[]
	/** A rollup or object-level push carries a collapse key instead; clear it when all its cards are handled. */
	collapseKey?: string | null
	threadId?: string | null
	/** App-icon badge to set (the actor's pending count); omitted leaves it untouched. */
	badge?: number | null
}

export interface PushChannel {
	/**
	 * Which Settings switch gates this channel: 'push' (the phone apps) or 'browser'. A channel
	 * without one is always sent to.
	 */
	readonly channelKind?: 'push' | 'browser'
	/** False when the channel is not configured; callers skip all work for it. */
	isEnabled(): boolean
	/** Push to every registered destination of an actor. Must never throw. */
	sendToActor(actorId: string, msg: PushMessage): Promise<void>
	/** Optional: take handled pushes off the actor's devices. Must never throw. */
	sendClearToActor?(actorId: string, clear: PushClear): Promise<void>
}
