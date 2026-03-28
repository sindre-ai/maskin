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
const STATUS_TO_ACTION: Record<string, string> = {
	ready: 'ready',
	joining_call: 'ready',
	in_waiting_room: 'ready',
	in_call_not_recording: 'ready',
	in_call_recording: 'recording',
	call_ended: 'done',
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

	// Only handle bot status change events
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
