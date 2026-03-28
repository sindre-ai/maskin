import { OpenAPIHono } from '@hono/zod-openapi'
import { checkWhisperHealth } from '../services/transcription.js'

const app = new OpenAPIHono()

app.get('/health', async (c) => {
	const whisperOk = await checkWhisperHealth()
	return c.json({
		whisper: whisperOk ? 'ok' : 'unavailable',
	})
})

export default app
