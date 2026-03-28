const RECALL_API_URL = process.env.RECALL_API_URL || 'https://api.recall.ai/api/v1'
const RECALL_API_KEY = process.env.RECALL_API_KEY || ''

export interface RecallBot {
	id: string
	meeting_url: string
	status_changes: Array<{
		code: string
		sub_code?: string
		created_at: string
	}>
	video_url: string | null
	bot_name: string
}

export interface CreateBotOptions {
	botName?: string
	joinAt?: string
}

function recallHeaders(): Record<string, string> {
	return {
		Authorization: `Token ${RECALL_API_KEY}`,
		'Content-Type': 'application/json',
	}
}

export async function createBot(
	meetingUrl: string,
	options?: CreateBotOptions,
): Promise<RecallBot> {
	const body: Record<string, unknown> = {
		meeting_url: meetingUrl,
	}
	if (options?.botName) body.bot_name = options.botName
	if (options?.joinAt) body.join_at = options.joinAt

	const res = await fetch(`${RECALL_API_URL}/bot`, {
		method: 'POST',
		headers: recallHeaders(),
		body: JSON.stringify(body),
	})

	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Recall API error (${res.status}): ${text}`)
	}

	return (await res.json()) as RecallBot
}

export async function getBot(botId: string): Promise<RecallBot> {
	const res = await fetch(`${RECALL_API_URL}/bot/${botId}`, {
		headers: recallHeaders(),
	})

	if (!res.ok) {
		throw new Error(`Recall API error (${res.status}): Failed to get bot ${botId}`)
	}

	return (await res.json()) as RecallBot
}

export async function downloadRecording(videoUrl: string): Promise<Buffer> {
	const res = await fetch(videoUrl, {
		headers: recallHeaders(),
	})

	if (!res.ok) {
		throw new Error(`Failed to download recording (${res.status})`)
	}

	return Buffer.from(await res.arrayBuffer())
}
