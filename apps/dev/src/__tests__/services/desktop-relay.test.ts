import { Duplex, PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signDesktopTicket } from '../../lib/desktop-ticket'
import {
	DESKTOP_STREAM_PATH,
	handleDesktopStreamUpgrade,
	isDesktopStreamRequest,
} from '../../services/desktop-relay'

const WS = '11111111-1111-4111-8111-111111111111'
const ACTOR = '22222222-2222-4222-8222-222222222222'
const AGENT = '44444444-4444-4444-8444-444444444444'

// A Duplex that records what is written to it and never connects anywhere.
function fakeSocket() {
	const written: string[] = []
	const sock = new Duplex({
		read() {},
		write(chunk, _enc, cb) {
			written.push(chunk.toString())
			cb()
		},
	})
	return { sock, written }
}

function fakeReq(url: string, rawHeaders: string[] = []) {
	return { url, rawHeaders } as never
}

const okDeps = () => ({
	isMember: vi.fn(async () => true),
	canAccess: vi.fn(async () => true),
	locate: vi.fn(async () => ({
		server: {
			id: 's',
			url: 'http://agent.example:3001',
			secret: 'srv-secret',
			status: 'active' as const,
		},
		password: 'pw',
	})),
})

describe('handleDesktopStreamUpgrade', () => {
	let original: string | undefined
	beforeEach(() => {
		original = process.env.INTEGRATION_ENCRYPTION_KEY
		process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32)
	})
	afterEach(() => {
		if (original === undefined) process.env.INTEGRATION_ENCRYPTION_KEY = undefined
		else process.env.INTEGRATION_ENCRYPTION_KEY = original
	})

	it('ignores other paths', async () => {
		const { sock } = fakeSocket()
		const handled = await handleDesktopStreamUpgrade(
			fakeReq('/api/other'),
			sock,
			Buffer.alloc(0),
			okDeps(),
		)
		expect(handled).toBe(false)
	})

	it('401s with no ticket or a bad one', async () => {
		for (const url of [DESKTOP_STREAM_PATH, `${DESKTOP_STREAM_PATH}?ticket=garbage`]) {
			const { sock, written } = fakeSocket()
			await handleDesktopStreamUpgrade(fakeReq(url), sock, Buffer.alloc(0), okDeps())
			expect(written.join('')).toMatch(/^HTTP\/1\.1 401/)
		}
	})

	it('403s when the actor left, or may no longer reach that agent', async () => {
		const patches = [
			{ isMember: vi.fn(async () => false) },
			// e.g. an agent whose ticket names a colleague, or the agent was removed
			{ canAccess: vi.fn(async () => false) },
		]
		for (const patch of patches) {
			const { sock, written } = fakeSocket()
			const ticket = signDesktopTicket({ workspaceId: WS, actorId: ACTOR, agentId: AGENT })
			await handleDesktopStreamUpgrade(
				fakeReq(`${DESKTOP_STREAM_PATH}?ticket=${ticket}`),
				sock,
				Buffer.alloc(0),
				{ ...okDeps(), ...patch },
			)
			expect(written.join('')).toMatch(/^HTTP\/1\.1 403/)
		}
	})

	it('404s when no desktop exists', async () => {
		const { sock, written } = fakeSocket()
		const ticket = signDesktopTicket({ workspaceId: WS, actorId: ACTOR, agentId: AGENT })
		await handleDesktopStreamUpgrade(
			fakeReq(`${DESKTOP_STREAM_PATH}?ticket=${ticket}`),
			sock,
			Buffer.alloc(0),
			{ ...okDeps(), locate: vi.fn(async () => null) },
		)
		expect(written.join('')).toMatch(/^HTTP\/1\.1 404/)
	})

	it('replays the handshake upstream with the server secret, not the browser credentials', async () => {
		const { sock } = fakeSocket()
		const upstream = new PassThrough()
		const sent: string[] = []
		upstream.on('data', (d) => sent.push(d.toString()))
		;(upstream as unknown as { connecting: boolean }).connecting = false
		const ticket = signDesktopTicket({ workspaceId: WS, actorId: ACTOR, agentId: AGENT })

		await handleDesktopStreamUpgrade(
			fakeReq(`${DESKTOP_STREAM_PATH}?ticket=${ticket}`, [
				'Host',
				'maskin.example',
				'Cookie',
				'session=abc',
				'Authorization',
				'Bearer user-key',
				'Upgrade',
				'websocket',
				'Sec-WebSocket-Key',
				'k3y',
			]),
			sock,
			Buffer.alloc(0),
			{ ...okDeps(), openUpstream: () => upstream as unknown as Duplex },
		)
		await new Promise((r) => setImmediate(r))

		const out = sent.join('')
		expect(out).toContain(`GET /desktops/${WS}/${AGENT}/stream HTTP/1.1`)
		expect(out).toContain('Authorization: Bearer srv-secret')
		expect(out).toContain('Host: agent.example:3001')
		expect(out).toContain('Upgrade: websocket')
		expect(out).toContain('Sec-WebSocket-Key: k3y')
		expect(out).not.toContain('user-key')
		expect(out).not.toContain('session=abc')
		expect(out).not.toContain('maskin.example')
		expect(out).not.toContain('ticket=')
	})

	it('does not accept a ticket twice', async () => {
		const ticket = signDesktopTicket({ workspaceId: WS, actorId: ACTOR, agentId: AGENT })
		const url = `${DESKTOP_STREAM_PATH}?ticket=${ticket}`
		const first = fakeSocket()
		await handleDesktopStreamUpgrade(fakeReq(url), first.sock, Buffer.alloc(0), {
			...okDeps(),
			locate: vi.fn(async () => null),
		})
		const second = fakeSocket()
		await handleDesktopStreamUpgrade(fakeReq(url), second.sock, Buffer.alloc(0), okDeps())
		expect(second.written.join('')).toMatch(/^HTTP\/1\.1 401/)
	})
})

// The server hands each upgrade to exactly one handler: the voice WebSocket handler answers
// every upgrade it is shown (an unknown path gets a 401 and a closed socket), so a desktop
// stream must never reach it.
describe('isDesktopStreamRequest', () => {
	it.each([
		[DESKTOP_STREAM_PATH, true],
		[`${DESKTOP_STREAM_PATH}?ticket=abc`, true],
		['/api/voice/ws', false],
		['/api/desktop/stream/extra', false],
		['/api/desktop', false],
		['/', false],
	])('%s -> %s', (url, expected) => {
		expect(isDesktopStreamRequest({ url })).toBe(expected)
	})

	it('is false when there is no url', () => {
		expect(isDesktopStreamRequest({ url: undefined })).toBe(false)
	})
})
