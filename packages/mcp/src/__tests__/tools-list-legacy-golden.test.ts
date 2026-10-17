import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

// The real SDK runs here, so the stdio transport that server.ts opens on
// import (its CLI entry point) is swapped for one that never touches the
// process's stdin or stdout. Everything else is the real SDK.
vi.mock('../sdk', async (importOriginal) => ({
	...(await importOriginal<typeof import('../sdk')>()),
	StdioServerTransport: class {
		async start() {}
		async close() {}
		async send() {}
	},
}))

import { InMemoryTransport } from '../sdk'
import { createMcpServer } from '../server'

// tools-list.legacy.golden.json was recorded from the legacy (SDK v1) server on
// main: every tool as tools/list returns it, in registration order, with its
// name, description, inputSchema, _meta and any annotations. It is the
// baseline the SDK swap is measured against, so it is never re-recorded from
// the swapped server. An intended change to the tool surface edits it by hand
// in the PR that makes the change.
const GOLDEN_PATH = new URL('./tools-list.legacy.golden.json', import.meta.url)

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

// Sorts object keys so a difference in the order a schema was built in is not
// a difference in what it says. Array order is kept: tool order is part of what
// is pinned.
function canonicalize(value: Json): Json {
	if (Array.isArray(value)) return value.map(canonicalize)
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalize(value[key])]),
		)
	}
	return value
}

// Drives the server with raw JSON-RPC over an in-memory pair, the way the HTTP
// route does, and returns the tools array exactly as it went on the wire.
async function listToolsOnTheWire(): Promise<Json[]> {
	const server = createMcpServer({
		apiBaseUrl: 'http://localhost:3000',
		apiKey: 'ank_testkey',
		defaultWorkspaceId: '00000000-0000-4000-8000-0000000000aa',
		// No-op sink so nothing is posted anywhere.
		telemetrySink: () => {},
	})
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
	await server.connect(serverSide)

	const pending = new Map<number, (message: { result?: { tools?: Json[] } }) => void>()
	clientSide.onmessage = (message) => {
		const { id } = message as { id?: number }
		if (typeof id === 'number') pending.get(id)?.(message as { result?: { tools?: Json[] } })
	}
	await clientSide.start()

	const request = (id: number, method: string, params?: Record<string, unknown>) =>
		new Promise<{ result?: { tools?: Json[] } }>((resolve) => {
			pending.set(id, resolve)
			void clientSide.send({ jsonrpc: '2.0', id, method, params })
		})

	await request(1, 'initialize', {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'golden-test', version: '1.0.0' },
	})
	await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
	const listed = await request(2, 'tools/list')
	await clientSide.close()
	return listed.result?.tools ?? []
}

describe('tools/list legacy golden', () => {
	it('matches the tool list recorded from v1 main, after canonicalising key order', async () => {
		const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as { tools: Json[] }
		expect(golden.tools.length).toBeGreaterThan(0)

		const live = await listToolsOnTheWire()

		expect(canonicalize(live)).toEqual(golden.tools)
	})
})
