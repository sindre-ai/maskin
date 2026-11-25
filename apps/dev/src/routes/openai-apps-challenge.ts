import { Hono } from 'hono'
import { createApiError } from '../lib/errors'

// The domain proof OpenAI asks for before an app can be listed in ChatGPT: the exact token as plain
// text at /.well-known/openai-apps-challenge. The token comes from OPENAI_APPS_CHALLENGE, set after
// deploy once OpenAI has issued it, never from the code. Unset or blank answers 404, so nothing is
// advertised half-configured. Public, no database, and registered ahead of the SPA fallthrough,
// which would otherwise answer the path with index.html.
const app = new Hono()

app.get('/.well-known/openai-apps-challenge', (c) => {
	const token = process.env.OPENAI_APPS_CHALLENGE?.trim()
	if (!token) return c.json(createApiError('NOT_FOUND', 'Not configured'), 404)
	return c.body(token, 200, {
		'Content-Type': 'text/plain; charset=utf-8',
		'Cache-Control': 'public, max-age=300',
	})
})

export default app
