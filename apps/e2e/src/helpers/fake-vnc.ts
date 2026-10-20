import { createHash } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import type { Socket } from 'node:net'
import type { Page } from '@playwright/test'

/**
 * A just-enough VNC server for noVNC, running as a real WebSocket server in the
 * test process. It speaks the RFB 3.8 handshake (no-auth security, a 1280x720
 * ServerInit) and then idles, which is all noVNC needs to report "connected".
 *
 * A real server rather than Playwright's `routeWebSocket`: noVNC inspects the
 * socket object it is handed, and the mocked one fails its "Raw channel missing
 * property" check.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function frame(payload: Buffer): Buffer {
	// Server -> client frames are unmasked. Binary opcode, final fragment.
	const len = payload.length
	const header =
		len < 126 ? Buffer.from([0x82, len]) : Buffer.from([0x82, 126, (len >> 8) & 0xff, len & 0xff])
	return Buffer.concat([header, payload])
}

function serverInit(): Buffer {
	const name = Buffer.from('e2e')
	const init = Buffer.alloc(24 + name.length)
	init.writeUInt16BE(1280, 0)
	init.writeUInt16BE(720, 2)
	init.writeUInt8(32, 4) // bits per pixel
	init.writeUInt8(24, 5) // depth
	init.writeUInt8(0, 6) // big-endian
	init.writeUInt8(1, 7) // true colour
	init.writeUInt16BE(255, 8)
	init.writeUInt16BE(255, 10)
	init.writeUInt16BE(255, 12)
	init.writeUInt8(16, 14)
	init.writeUInt8(8, 15)
	init.writeUInt8(0, 16)
	init.writeUInt32BE(name.length, 20)
	name.copy(init, 24)
	return init
}

/** Decodes the masked client frames in `buf`; returns the payloads and what is left over. */
function readFrames(buf: Buffer): { messages: Buffer[]; rest: Buffer } {
	const messages: Buffer[] = []
	let offset = 0
	while (buf.length - offset >= 2) {
		const opcode = buf[offset] & 0x0f
		let len = buf[offset + 1] & 0x7f
		let pos = offset + 2
		if (len === 126) {
			if (buf.length < pos + 2) break
			len = buf.readUInt16BE(pos)
			pos += 2
		} else if (len === 127) {
			if (buf.length < pos + 8) break
			len = Number(buf.readBigUInt64BE(pos))
			pos += 8
		}
		if (buf.length < pos + 4 + len) break
		const mask = buf.subarray(pos, pos + 4)
		const data = Buffer.from(buf.subarray(pos + 4, pos + 4 + len))
		for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4] as number
		if (opcode === 2 || opcode === 1) messages.push(data)
		offset = pos + 4 + len
	}
	return { messages, rest: buf.subarray(offset) }
}

function serve(socket: Socket): void {
	let step = 0
	let pending: Buffer = Buffer.alloc(0)
	socket.write(frame(Buffer.from('RFB 003.008\n')))
	socket.on('data', (chunk) => {
		pending = Buffer.concat([pending, chunk as Buffer])
		const { messages, rest } = readFrames(pending)
		pending = Buffer.from(rest)
		for (const _m of messages) {
			step += 1
			if (step === 1)
				socket.write(frame(Buffer.from([1, 1]))) // version chosen -> offer "None"
			else if (step === 2)
				socket.write(frame(Buffer.from([0, 0, 0, 0]))) // SecurityResult OK
			else if (step === 3) socket.write(frame(serverInit())) // ClientInit -> ServerInit
		}
	})
	socket.on('error', () => {})
}

export type FakeVnc = { port: number; close: () => Promise<void> }

export async function startFakeVnc(): Promise<FakeVnc> {
	const sockets = new Set<Socket>()
	const server: Server = createServer((_req, res) => {
		res.writeHead(426).end()
	})
	server.on('upgrade', (req, socket: Socket) => {
		const key = String(req.headers['sec-websocket-key'] ?? '')
		const accept = createHash('sha1')
			.update(key + GUID)
			.digest('base64')
		// A browser fails the connection unless the server selects a requested subprotocol.
		const requested = String(req.headers['sec-websocket-protocol'] ?? '')
			.split(',')
			.map((s) => s.trim())
		const protocol = requested.includes('binary') ? 'Sec-WebSocket-Protocol: binary\r\n' : ''
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${protocol}\r\n`,
		)
		sockets.add(socket)
		socket.on('close', () => sockets.delete(socket))
		serve(socket)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	const port = typeof address === 'object' && address ? address.port : 0
	return {
		port,
		close: () =>
			new Promise<void>((resolve) => {
				for (const s of sockets) s.destroy()
				server.close(() => resolve())
			}),
	}
}

/** Points the page's desktop stream at a fake VNC server. Returns it so the test can close it. */
export async function attachFakeVnc(page: Page): Promise<FakeVnc> {
	const vnc = await startFakeVnc()
	await page.addInitScript((port: number) => {
		// A Proxy keeps the constructor callable with `new`, keeps the native statics,
		// and still returns a genuine native socket (noVNC inspects its prototype).
		window.WebSocket = new Proxy(window.WebSocket, {
			construct(target, args: [string | URL, (string | string[])?]) {
				const [url, protocols] = args
				const to = String(url).includes('/api/desktop/stream') ? `ws://127.0.0.1:${port}/` : url
				return Reflect.construct(target, [to, protocols])
			},
		})
	}, vnc.port)
	return vnc
}
