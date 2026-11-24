/**
 * HTTP entry for the gateway. Stateless: each POST /mcp reads the two tokens from its own
 * headers, builds a server for that call, and forgets them. Nothing is written to disk or logged.
 */

import { createServer } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Credentials } from './client.js'
import { buildServer } from './server.js'

// Room for one receipt of up to 4 MB, base64 encoded, plus the call around it.
const MAX_BODY_BYTES = 6_000_000

export function credentialsFrom(headers: Record<string, string | string[] | undefined>) {
	const one = (name: string): string => {
		const value = headers[name]
		return (Array.isArray(value) ? value[0] : value)?.trim() ?? ''
	}
	const appSecretToken = one('x-appsecrettoken')
	const agreementGrantToken = one('x-agreementgranttoken')
	if (!appSecretToken || !agreementGrantToken) return null
	return { appSecretToken, agreementGrantToken } satisfies Credentials
}

async function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		size += (chunk as Buffer).length
		if (size > MAX_BODY_BYTES) throw new Error('Request too large')
		chunks.push(chunk as Buffer)
	}
	const text = Buffer.concat(chunks).toString('utf8')
	return text ? JSON.parse(text) : undefined
}

export function createHttpServer() {
	return createServer(async (req, res) => {
		const path = (req.url ?? '').split('?')[0]
		if (req.method === 'GET' && path === '/health') {
			res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
			return
		}
		if (path !== '/mcp' || req.method !== 'POST') {
			res.writeHead(path === '/mcp' ? 405 : 404).end()
			return
		}
		try {
			const body = await readBody(req)
			const server = buildServer(credentialsFrom(req.headers))
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			})
			res.on('close', () => {
				transport.close()
				server.close()
			})
			await server.connect(transport)
			await transport.handleRequest(req, res, body)
		} catch {
			if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' })
			res.end(JSON.stringify({ error: 'Bad request' }))
		}
	})
}

if (process.argv[1]?.endsWith('http.js')) {
	const port = Number.parseInt(process.env.PORT ?? '8080', 10)
	createHttpServer().listen(port, () => console.error(`economic-mcp listening on ${port}`))
}
