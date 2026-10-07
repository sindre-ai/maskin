// In-memory stand-in for the Resend API, used only by the E2E run.
//
// The dev server is started with RESEND_BASE_URL pointing here (see
// playwright.config.ts), so packages/email's real Resend SDK call lands in this
// process instead of api.resend.com. Specs read the "sent" mail back from
// GET /__sink to recover the accept-invite link, which is only ever delivered
// by email. Nothing here is reachable outside the E2E run.
import { createServer } from 'node:http'

const port = Number(process.env.E2E_MOCK_RESEND_PORT ?? 4010)
const sent = []

function readBody(req) {
	return new Promise((resolve) => {
		const chunks = []
		req.on('data', (c) => chunks.push(c))
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
	})
}

createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://localhost')
	res.setHeader('Content-Type', 'application/json')

	if (req.method === 'POST' && url.pathname === '/emails') {
		const body = JSON.parse((await readBody(req)) || '{}')
		sent.push({ ...body, sentAt: Date.now() })
		res.end(JSON.stringify({ id: `mock-${sent.length}` }))
		return
	}
	if (req.method === 'GET' && url.pathname === '/__sink') {
		res.end(JSON.stringify(sent))
		return
	}
	if (req.method === 'DELETE' && url.pathname === '/__sink') {
		sent.length = 0
		res.end(JSON.stringify({ cleared: true }))
		return
	}
	res.statusCode = 404
	res.end(JSON.stringify({ message: 'not found' }))
}).listen(port, () => console.log(`mock-resend listening on ${port}`))
