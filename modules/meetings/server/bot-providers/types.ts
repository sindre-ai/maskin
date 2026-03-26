/** Configuration for a bot provider, extracted from integration credentials */
export interface BotProviderConfig {
	apiKey: string
	webhookSecret?: string
	[key: string]: unknown
}

/** Parameters for scheduling a bot to join a meeting */
export interface ScheduleBotParams {
	/** Meeting join URL (Zoom/Meet/Teams link) */
	meetingUrl: string
	/** Meeting title (used as bot display name context) */
	meetingTitle?: string
	/** Scheduled start time (ISO 8601) — some providers use this for scheduling */
	startTime?: string
	/** Deduplication key to prevent duplicate bots */
	deduplicationKey?: string
	/** Custom bot display name */
	botName?: string
}

/** Result of scheduling a bot */
export interface ScheduleBotResult {
	botId: string
	status: 'pending' | 'scheduled'
}

/** Current status of a bot */
export interface BotStatus {
	botId: string
	status: 'pending' | 'joining' | 'in_meeting' | 'recording' | 'processing' | 'done' | 'failed'
	recordingUrl?: string
	durationSeconds?: number
}

/** Recording data from a completed bot session */
export interface BotRecording {
	/** URL to download the recording */
	downloadUrl: string
	/** File format (mp4, webm, mp3, etc.) */
	format: string
	/** Duration in seconds */
	durationSeconds?: number
	/** File size in bytes */
	sizeBytes?: number
	/** Speaker timeline for diarization */
	speakerTimeline?: Array<{
		speaker: string
		startMs: number
		endMs: number
	}>
}

/** Normalized webhook event from a bot provider */
export interface NormalizedBotWebhookEvent {
	/** The bot ID this event relates to */
	botId: string
	/** Type of event */
	eventType: 'status_change' | 'recording_ready' | 'error'
	/** New status (for status_change events) */
	status?: string
	/** Recording URL (for recording_ready events) */
	recordingUrl?: string
	/** Error message (for error events) */
	error?: string
	/** Raw provider payload for debugging */
	raw: unknown
}

/**
 * Interface for meeting bot providers (Recall.ai, Fireflies, MeetingBaaS).
 * Each provider implements this to handle bot scheduling, status checks, and recording retrieval.
 * The provider is stateless — credentials are passed in via BotProviderConfig on each call.
 */
export interface BotProvider {
	/** Provider identifier (e.g., 'recall', 'fireflies', 'meetingbaas') */
	name: string

	/** Schedule a bot to join a meeting */
	scheduleBot(params: ScheduleBotParams, config: BotProviderConfig): Promise<ScheduleBotResult>

	/** Cancel/remove a scheduled or active bot */
	cancelBot(botId: string, config: BotProviderConfig): Promise<void>

	/** Get current bot status */
	getBotStatus(botId: string, config: BotProviderConfig): Promise<BotStatus>

	/** Get recording after bot session is complete */
	getRecording(botId: string, config: BotProviderConfig): Promise<BotRecording>

	/** Verify an incoming webhook signature */
	verifyWebhook(body: string, signature: string, config: BotProviderConfig): boolean

	/** Normalize a webhook payload into a standard event */
	normalizeWebhookEvent(
		payload: unknown,
		headers: Record<string, string>,
	): NormalizedBotWebhookEvent | null
}
