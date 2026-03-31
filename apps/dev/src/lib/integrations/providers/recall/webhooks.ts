import type { CustomEventNormalizer, NormalizedEvent } from '../../types'

/**
 * Recall.ai webhook payload structure (bot status change).
 *
 * Example:
 * {
 *   "event": "bot.status_change",
 *   "data": {
 *     "bot_id": "abc-123",
 *     "status": { "code": "done", "sub_code": "call_ended_by_host" },
 *     "meeting_url": "https://meet.google.com/abc-def-ghi",
 *     "video_url": "https://api.recall.ai/api/v1/bot/abc-123/recording"
 *   }
 * }
 */

/** Map Recall status codes to normalized actions */
/** Map Recall bot status codes to our normalized actions.
 * Object statuses: scheduled → recording → transcribing → completed / failed
 * - 'joining': bot is on its way but not recording yet (object stays 'scheduled')
 * - 'recording': bot is actively recording (object → 'recording')
 * - 'done': recording finished, ready for processing (object → 'transcribing')
 * - 'fatal': bot failed (object → 'failed')
 */
const STATUS_TO_ACTION: Record<string, string> = {
	ready: 'joining',
	joining_call: 'joining',
	in_waiting_room: 'joining',
	in_call_not_recording: 'joining',
	in_call_recording: 'recording',
	call_ended: 'joining',
	recording_done: 'done',
	done: 'done',
	fatal: 'fatal',
	analysis_done: 'done',
}

export const recallEventNormalizer: CustomEventNormalizer = (
	payload: unknown,
	_headers: Record<string, string>,
): NormalizedEvent | null => {
	if (typeof payload !== 'object' || payload === null) return null

	const body = payload as Record<string, unknown>
	const event = body.event as string | undefined

	// Handle calendar sync events (Calendar V2)
	if (event === 'calendar.sync_events') {
		const data = body.data as Record<string, unknown> | undefined
		if (!data) return null

		const calendarId = data.calendar_id as string | undefined
		if (!calendarId) return null

		return {
			entityType: 'recall.calendar',
			action: 'sync_events',
			installationId: calendarId,
			data: {
				calendar_id: calendarId,
				last_updated_ts: (data.last_updated_ts as string) ?? null,
			},
		}
	}

	// Handle bot status change events
	if (event !== 'bot.status_change') return null

	const data = body.data as Record<string, unknown> | undefined
	if (!data) return null

	const botId = data.bot_id as string | undefined
	if (!botId) return null

	const status = data.status as Record<string, unknown> | undefined
	const statusCode = (status?.code as string) ?? ''
	const action = STATUS_TO_ACTION[statusCode]
	if (!action) return null

	return {
		entityType: 'recall.bot',
		action,
		installationId: botId,
		data: {
			bot_id: botId,
			status_code: statusCode,
			sub_code: status?.sub_code ?? null,
			meeting_url: data.meeting_url ?? null,
			video_url: data.video_url ?? null,
		},
	}
}
