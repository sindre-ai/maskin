import type {
	BotProvider,
	BotProviderConfig,
	BotRecording,
	BotStatus,
	NormalizedBotWebhookEvent,
	ScheduleBotParams,
	ScheduleBotResult,
} from './types.js'

const RECALL_API_BASE = 'https://us-west-2.recall.ai/api/v1'

async function recallFetch(
	path: string,
	config: BotProviderConfig,
	options?: RequestInit,
): Promise<Response> {
	const url = `${RECALL_API_BASE}${path}`
	const response = await fetch(url, {
		...options,
		headers: {
			Authorization: `Token ${config.apiKey}`,
			'Content-Type': 'application/json',
			...options?.headers,
		},
	})
	if (!response.ok) {
		const text = await response.text()
		throw new Error(`Recall API error ${response.status}: ${text}`)
	}
	return response
}

const STATUS_MAP: Record<string, BotStatus['status']> = {
	ready: 'pending',
	joining_call: 'joining',
	in_waiting_room: 'joining',
	in_call_not_recording: 'in_meeting',
	in_call_recording: 'recording',
	call_ended: 'processing',
	done: 'done',
	analysis_done: 'done',
}

export class RecallBotProvider implements BotProvider {
	name = 'recall'

	async scheduleBot(
		params: ScheduleBotParams,
		config: BotProviderConfig,
	): Promise<ScheduleBotResult> {
		const body: Record<string, unknown> = {
			meeting_url: params.meetingUrl,
			bot_name: params.botName || 'Maskin Notetaker',
		}
		if (params.deduplicationKey) {
			body.deduplication_key = params.deduplicationKey
		}

		const response = await recallFetch('/bot/', config, {
			method: 'POST',
			body: JSON.stringify(body),
		})
		const data = (await response.json()) as { id: string }
		return { botId: data.id, status: 'pending' }
	}

	async cancelBot(botId: string, config: BotProviderConfig): Promise<void> {
		await recallFetch(`/bot/${botId}/leave/`, config, { method: 'POST' })
	}

	async getBotStatus(botId: string, config: BotProviderConfig): Promise<BotStatus> {
		const response = await recallFetch(`/bot/${botId}/`, config)
		const data = (await response.json()) as {
			id: string
			status: { code: string }
			video_url?: string
		}

		const status =
			STATUS_MAP[data.status.code] ?? (data.status.code.startsWith('fatal') ? 'failed' : 'pending')

		return {
			botId: data.id,
			status,
			recordingUrl: data.video_url,
		}
	}

	async getRecording(botId: string, config: BotProviderConfig): Promise<BotRecording> {
		const response = await recallFetch(`/bot/${botId}/`, config)
		const data = (await response.json()) as {
			video_url?: string
			media?: { url?: string }
		}

		const downloadUrl = data.video_url || data.media?.url
		if (!downloadUrl) {
			throw new Error('No recording available for this bot')
		}

		return {
			downloadUrl,
			format: 'mp4',
		}
	}

	verifyWebhook(_body: string, _signature: string, _config: BotProviderConfig): boolean {
		// TODO: Implement Svix HMAC-SHA256 verification
		// Recall uses Svix for webhook signing
		// Headers: webhook-id, webhook-timestamp, webhook-signature
		return true
	}

	normalizeWebhookEvent(
		payload: unknown,
		_headers: Record<string, string>,
	): NormalizedBotWebhookEvent | null {
		const data = payload as Record<string, unknown>
		const event = data.event as string
		if (!event) return null

		const eventData = data.data as Record<string, unknown> | undefined
		const botId = (eventData?.bot_id as string) ?? (eventData?.bot as { id?: string })?.id

		if (!botId) return null

		// Determine event type from status code
		const statusCode = (eventData?.status as { code?: string })?.code

		if (statusCode === 'done' || statusCode === 'analysis_done') {
			return {
				botId,
				eventType: 'recording_ready',
				status: 'done',
				recordingUrl: eventData?.video_url as string | undefined,
				raw: payload,
			}
		}

		if (statusCode?.startsWith('fatal')) {
			return {
				botId,
				eventType: 'error',
				status: 'failed',
				error: statusCode,
				raw: payload,
			}
		}

		return {
			botId,
			eventType: 'status_change',
			status: statusCode,
			raw: payload,
		}
	}
}
