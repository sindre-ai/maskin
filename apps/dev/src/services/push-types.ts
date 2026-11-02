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

export interface PushChannel {
	/** False when the channel is not configured; callers skip all work for it. */
	isEnabled(): boolean
	/** Push to every registered destination of an actor. Must never throw. */
	sendToActor(actorId: string, msg: PushMessage): Promise<void>
}
