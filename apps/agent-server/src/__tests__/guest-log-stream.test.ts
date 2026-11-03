import { describe, expect, it, vi } from 'vitest'

vi.mock('@sentry/node', () => ({
	captureMessage: vi.fn(),
	addBreadcrumb: vi.fn(),
}))

import * as Sentry from '@sentry/node'
import {
	GUEST_LOG_MAX_LINE_BYTES,
	type GuestLogSinkOptions,
	createGuestLogSink,
	redactSecrets,
} from '../lib/guest-log-stream'

type Emitted = { msg: string; ctx: Record<string, unknown> }

function makeSink(overrides: Partial<GuestLogSinkOptions> = {}) {
	const emitted: Emitted[] = []
	const capped: Emitted[] = []
	// Injected clock: window behaviour is tested by advancing this, so no fake
	// timers and no sleeps.
	let clock = 1_000_000
	const advance = (ms: number) => {
		clock += ms
	}
	const sink = createGuestLogSink({
		sessionId: 'sess-abc',
		emit: (msg, ctx) => emitted.push({ msg, ctx }),
		emitCapped: (msg, ctx) => capped.push({ msg, ctx }),
		now: () => clock,
		...overrides,
	})
	return {
		sink,
		emitted,
		capped,
		advance,
		lines: () => emitted.map((e) => e.ctx.line as string),
	}
}

describe('createGuestLogSink line buffering', () => {
	it('emits one log line per newline-terminated guest line', () => {
		const { sink, lines } = makeSink()
		sink.push('stderr', '[system] input-stream: connected\n[system] input-stream: seq=1\n')
		expect(lines()).toEqual(['[system] input-stream: connected', '[system] input-stream: seq=1'])
	})

	it('reassembles a line split across chunks instead of emitting per chunk', () => {
		const { sink, lines } = makeSink()
		sink.push('stderr', '[system] input-str')
		expect(lines()).toEqual([])
		sink.push('stderr', 'eam: exiting with ')
		expect(lines()).toEqual([])
		sink.push('stderr', 'code 1\n')
		expect(lines()).toEqual(['[system] input-stream: exiting with code 1'])
	})

	it('keeps stdout and stderr partials separate when they interleave', () => {
		const { sink, emitted } = makeSink()
		sink.push('stdout', 'out-par')
		sink.push('stderr', 'err-par')
		sink.push('stdout', 'tial\n')
		sink.push('stderr', 'tial\n')
		expect(emitted.map((e) => [e.ctx.stream, e.ctx.line])).toEqual([
			['stdout', 'out-partial'],
			['stderr', 'err-partial'],
		])
	})

	it('strips CR so CRLF and progress-spinner output do not log as one blob', () => {
		const { sink, lines } = makeSink()
		sink.push('stderr', 'first\r\nsecond\r\n')
		expect(lines()).toEqual(['first', 'second'])
	})

	it('drops blank and whitespace-only lines', () => {
		const { sink, lines } = makeSink()
		sink.push('stderr', 'real\n\n   \n\nalso real\n')
		expect(lines()).toEqual(['real', 'also real'])
	})

	it('accepts Buffer chunks and decodes them as utf8', () => {
		const { sink, lines } = makeSink()
		sink.push('stderr', Buffer.from('bygget kjorte OK\n', 'utf8'))
		expect(lines()).toEqual(['bygget kjorte OK'])
	})

	it('tags every line with sessionId, source and stream', () => {
		const { sink, emitted } = makeSink()
		sink.push('stderr', 'hello\n')
		expect(emitted[0]?.ctx).toEqual({
			sessionId: 'sess-abc',
			source: 'msb-exec',
			stream: 'stderr',
			line: 'hello',
		})
	})

	it('flushes a trailing partial line on close', () => {
		const { sink, lines } = makeSink()
		sink.push('stderr', 'no trailing newline')
		expect(lines()).toEqual([])
		sink.close()
		expect(lines()).toEqual(['no trailing newline'])
	})

	it('is idempotent on repeated close and ignores pushes after close', () => {
		const { sink, lines } = makeSink()
		sink.push('stderr', 'tail')
		sink.close()
		sink.close()
		sink.push('stderr', 'after\n')
		expect(lines()).toEqual(['tail'])
	})

	it('flushes a newline-less stream once it passes the per-line ceiling', () => {
		const { sink, lines } = makeSink()
		sink.push('stderr', 'x'.repeat(GUEST_LOG_MAX_LINE_BYTES * 2 + 5))
		// Two full-length lines emitted, remainder still buffered.
		expect(lines()).toHaveLength(2)
		expect(lines()[0]).toHaveLength(GUEST_LOG_MAX_LINE_BYTES)
		sink.close()
		expect(lines()).toHaveLength(3)
		expect(lines()[2]).toHaveLength(5)
	})

	it('truncates an over-long single line with a marker', () => {
		const { sink, lines } = makeSink()
		sink.push('stderr', `${'y'.repeat(GUEST_LOG_MAX_LINE_BYTES + 500)}\n`)
		expect(lines()[0]?.startsWith('yyyy')).toBe(true)
		expect(lines()[0]?.endsWith('[truncated]')).toBe(true)
	})
})

describe('createGuestLogSink rate cap', () => {
	const WINDOW = 60_000

	it('stops emitting past the line cap within a window and reports it once', () => {
		const { sink, lines, capped } = makeSink({ maxLines: 3, windowMs: WINDOW })
		for (let i = 0; i < 10; i++) sink.push('stderr', `line ${i}\n`)
		expect(lines()).toEqual(['line 0', 'line 1', 'line 2'])
		expect(capped).toHaveLength(1)
		expect(capped[0]?.msg).toContain('rate cap reached')
	})

	it('stops emitting past the byte cap within a window', () => {
		const { sink, lines, capped } = makeSink({ maxBytes: 10, windowMs: WINDOW })
		sink.push('stderr', 'aaaaaaaaaaaa\n')
		sink.push('stderr', 'bbbb\n')
		expect(lines()).toEqual(['aaaaaaaaaaaa'])
		expect(capped[0]?.ctx.sessionId).toBe('sess-abc')
	})

	it('shares one budget across stdout and stderr', () => {
		const { sink, lines } = makeSink({ maxLines: 2, windowMs: WINDOW })
		sink.push('stdout', 'a\n')
		sink.push('stderr', 'b\n')
		sink.push('stderr', 'c\n')
		expect(lines()).toEqual(['a', 'b'])
	})

	// The property this cap exists for: a session that was chatty early must
	// still be observable hours later. A lifetime budget would fail this.
	it('lets output through in a later window after a saturating burst', () => {
		const { sink, lines, advance } = makeSink({ maxLines: 2, windowMs: WINDOW })
		for (let i = 0; i < 50; i++) sink.push('stderr', `burst ${i}\n`)
		expect(lines()).toEqual(['burst 0', 'burst 1'])

		advance(WINDOW)
		sink.push('stderr', 'much later: input-stream exited\n')
		expect(lines()).toContain('much later: input-stream exited')
	})

	it('keeps admitting a window of output for as long as the session runs', () => {
		const { sink, lines, advance } = makeSink({ maxLines: 1, windowMs: WINDOW })
		for (let w = 0; w < 20; w++) {
			sink.push('stderr', `w${w}-a\n`)
			sink.push('stderr', `w${w}-b\n`)
			advance(WINDOW)
		}
		// One line admitted per window, every window — never goes permanently dark.
		expect(lines()).toEqual(Array.from({ length: 20 }, (_, w) => `w${w}-a`))
	})

	it('re-arms the cap warning on each new window rather than firing once per session', () => {
		const { sink, capped, advance } = makeSink({ maxLines: 1, windowMs: WINDOW })
		sink.push('stderr', 'a1\n')
		sink.push('stderr', 'a2\n')
		advance(WINDOW)
		sink.push('stderr', 'b1\n')
		sink.push('stderr', 'b2\n')
		const reached = capped.filter((c) => c.msg.includes('rate cap reached'))
		expect(reached).toHaveLength(2)
	})

	it('reports how many lines the closing window dropped', () => {
		const { sink, capped, advance } = makeSink({ maxLines: 2, windowMs: WINDOW })
		for (let i = 0; i < 9; i++) sink.push('stderr', `line ${i}\n`)
		advance(WINDOW)
		sink.push('stderr', 'next window\n')
		const closed = capped.find((c) => c.msg.includes('window closed'))
		expect(closed?.ctx.droppedLines).toBe(7)
	})

	it('reports the total suppressed line count on close', () => {
		const { sink, capped } = makeSink({ maxLines: 2, windowMs: WINDOW })
		for (let i = 0; i < 9; i++) sink.push('stderr', `line ${i}\n`)
		sink.close()
		const summary = capped.find((c) => c.msg === 'guest log output suppressed')
		expect(summary?.ctx.suppressedLines).toBe(7)
	})

	it('does not report suppression when the cap was never reached', () => {
		const { sink, capped } = makeSink({ maxLines: 100, windowMs: WINDOW })
		sink.push('stderr', 'quiet\n')
		sink.close()
		expect(capped).toEqual([])
	})
})

describe('createGuestLogSink utf-8 handling', () => {
	it('reassembles a multi-byte character split across a chunk boundary', () => {
		const { sink, lines } = makeSink()
		const buf = Buffer.from('bygget kjørte OK\n', 'utf8')
		// Split inside the two-byte 'ø'.
		const split = buf.indexOf(Buffer.from('ø', 'utf8')) + 1
		sink.push('stderr', buf.subarray(0, split))
		sink.push('stderr', buf.subarray(split))
		expect(lines()).toEqual(['bygget kjørte OK'])
		expect(lines()[0]).not.toContain('\uFFFD')
	})

	it('flushes a character left incomplete when the stream ends', () => {
		const { sink, lines } = makeSink()
		const buf = Buffer.from('slutt: æ', 'utf8')
		const split = buf.length - 1
		sink.push('stderr', buf.subarray(0, split))
		sink.push('stderr', buf.subarray(split))
		sink.close()
		expect(lines()).toEqual(['slutt: æ'])
	})

	it('accounts a non-ASCII line at its true utf-8 byte size, not its char count', () => {
		// 'é' is 2 bytes; 6 chars = 12 bytes. A cap of 11 bytes must reject the
		// second line, which a String.length-based budget would have admitted.
		const { sink, lines } = makeSink({ maxBytes: 11 })
		sink.push('stderr', 'éééééé\n')
		sink.push('stderr', 'second\n')
		expect(lines()).toEqual(['éééééé'])
	})

	it('truncates an over-long non-ASCII line without splitting a character', () => {
		const { sink, lines } = makeSink()
		const wide = 'é'.repeat(GUEST_LOG_MAX_LINE_BYTES)
		sink.push('stderr', `${wide}\n`)
		const out = lines()[0] ?? ''
		expect(out.endsWith('[truncated]')).toBe(true)
		expect(out).not.toContain('\uFFFD')
		const body = out.slice(0, -'…[truncated]'.length)
		expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(GUEST_LOG_MAX_LINE_BYTES)
		// Every character survived intact — no half-character at the cut.
		expect(new Set(body)).toEqual(new Set(['é']))
	})
})

describe('redactSecrets', () => {
	it.each([
		['GITHUB_TOKEN=ghp_abcdefghij0123456789ABCDEFGHIJ', 'ghp_'],
		['env dump: ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAA', 'sk-ant-'],
		['Authorization: Bearer eyJhbGciOi.eyJzdWIiOjEyMw.SflKxwRJSMeKKF2QT4', 'eyJ'],
		['curl https://x-access-token:ghs_ABCDEFGHIJ0123456789@github.com/o/r', 'ghs_'],
		['{"MCP_SECRET": "hunter2hunter2hunter2"}', 'hunter2'],
		['x-api-key: sk-abcdefghij0123456789abcdefghij', 'sk-'],
		['token is github_pat_11ABCDEFG0abcdefghijklmnop', 'github_pat_'],
		['MASKIN_API_KEY=ank_abcdefghij0123456789', 'ank_'],
		['SLACK_TOKEN=xoxb-1234567890-abcdefghijk', 'xoxb-'],
	])('redacts %s', (input, leak) => {
		const out = redactSecrets(input)
		expect(out).not.toContain(leak)
		expect(out).toContain('[REDACTED]')
	})

	it('leaves ordinary diagnostic lines untouched', () => {
		const line = '[system] input-stream: connected to /sessions/abc/input/stream (lastSeq=4)'
		expect(redactSecrets(line)).toBe(line)
	})

	it('redacts every secret in a line with more than one', () => {
		const out = redactSecrets('GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaa AND sk-ant-bbbbbbbbbbbbbbbb')
		expect(out).not.toContain('ghp_')
		expect(out).not.toContain('sk-ant-')
	})

	it('runs before anything is emitted by the sink', () => {
		const { sink, lines } = makeSink()
		sink.push('stderr', 'fatal: could not read GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaa\n')
		expect(lines()[0]).toBe('fatal: could not read GITHUB_TOKEN=[REDACTED]')
	})
})

describe('guest log level', () => {
	// Requirement 3: guest output is diagnostic, not exceptional. logger.error
	// calls Sentry.captureMessage, so routing a chatty guest stream there would
	// flood Sentry with thousands of non-actionable events.
	it('defaults to logger.info for guest lines and never logger.error', async () => {
		const { logger } = await import('../lib/logger')
		const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
		const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
		try {
			const sink = createGuestLogSink({ sessionId: 'sess-lvl' })
			sink.push('stderr', 'guest is unhappy: connection refused\n')
			sink.close()
			expect(info).toHaveBeenCalledWith('guest log', expect.objectContaining({ stream: 'stderr' }))
			expect(error).not.toHaveBeenCalled()
		} finally {
			info.mockRestore()
			error.mockRestore()
		}
	})

	it('does not send guest stderr to Sentry.captureMessage', () => {
		vi.mocked(Sentry.captureMessage).mockClear()
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		try {
			const sink = createGuestLogSink({ sessionId: 'sess-sentry' })
			sink.push('stderr', 'ERROR: everything is on fire\nFATAL: still on fire\n')
			sink.close()
			expect(Sentry.captureMessage).not.toHaveBeenCalled()
		} finally {
			write.mockRestore()
		}
	})
})
