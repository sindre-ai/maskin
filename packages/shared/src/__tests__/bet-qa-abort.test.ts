import { type AddressInfo, createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	BET_QA_EVENT_PREFIX,
	abortBetQa,
	classifyVercelBypassResponse,
	formatBypassFailureEvent,
	formatInstrumentationGapComment,
} from '../bet-qa/abort'

const FROZEN_NOW = () => new Date('2026-06-23T05:00:00.000Z')

describe('classifyVercelBypassResponse', () => {
	it('returns null when response is authenticated', () => {
		const reason = classifyVercelBypassResponse(
			{ status: 200, headers: { 'content-type': 'text/html' }, bodyText: '<html>app</html>' },
			'a-real-secret',
		)
		expect(reason).toBeNull()
	})

	it('returns vercel_bypass_missing on a 401 challenge with empty secret', () => {
		const reason = classifyVercelBypassResponse(
			{
				status: 401,
				headers: { 'content-type': 'text/html' },
				bodyText: 'Authentication Required',
			},
			'',
		)
		expect(reason).toBe('vercel_bypass_missing')
	})

	it('returns vercel_bypass_missing on a 401 challenge with undefined secret', () => {
		const reason = classifyVercelBypassResponse(
			{
				status: 401,
				headers: {},
				bodyText: 'Authentication Required',
			},
			undefined,
		)
		expect(reason).toBe('vercel_bypass_missing')
	})

	it('returns vercel_bypass_invalid on a 401 challenge with present-but-wrong secret', () => {
		const reason = classifyVercelBypassResponse(
			{
				status: 401,
				headers: {},
				bodyText: 'Authentication Required',
			},
			'definitely-wrong',
		)
		expect(reason).toBe('vercel_bypass_invalid')
	})

	it('detects the challenge via Set-Cookie _vercel_sso_nonce', () => {
		const reason = classifyVercelBypassResponse(
			{
				status: 200,
				headers: { 'set-cookie': '_vercel_sso_nonce=abc; Path=/; HttpOnly' },
				bodyText: '<html><meta http-equiv="refresh" content="0; url=/sso-api"></html>',
			},
			'bad',
		)
		expect(reason).toBe('vercel_bypass_invalid')
	})

	it('detects the challenge via SSO body markup when status is 200', () => {
		const reason = classifyVercelBypassResponse(
			{
				status: 200,
				headers: {},
				bodyText: '<a href="https://vercel.com/sso-api?url=...">continue</a>',
			},
			'bad',
		)
		expect(reason).toBe('vercel_bypass_invalid')
	})

	it('is case-insensitive on header names (Set-Cookie vs set-cookie)', () => {
		const reason = classifyVercelBypassResponse(
			{
				status: 200,
				headers: { 'Set-Cookie': '_vercel_sso=abc' },
				bodyText: '',
			},
			'bad',
		)
		expect(reason).toBe('vercel_bypass_invalid')
	})
})

describe('formatBypassFailureEvent', () => {
	it('returns a stable structured event and a newline-terminated stdout line', () => {
		const { event, line } = formatBypassFailureEvent({
			reason: 'vercel_bypass_invalid',
			previewUrl: 'https://preview-xyz.vercel.app',
			sessionId: 'sess-123',
			betId: 'bet-abc',
			now: FROZEN_NOW,
		})

		expect(event).toEqual({
			event: 'bet_qa_aborted',
			reason: 'vercel_bypass_invalid',
			previewUrl: 'https://preview-xyz.vercel.app',
			sessionId: 'sess-123',
			betId: 'bet-abc',
			occurredAt: '2026-06-23T05:00:00.000Z',
		})

		expect(line.startsWith(`${BET_QA_EVENT_PREFIX} `)).toBe(true)
		expect(line.endsWith('\n')).toBe(true)
		const parsed = JSON.parse(line.slice(BET_QA_EVENT_PREFIX.length + 1).trimEnd())
		expect(parsed).toEqual(event)
	})
})

describe('formatInstrumentationGapComment', () => {
	it('opens with the agreed instrumentation-gap phrase + reason', () => {
		const body = formatInstrumentationGapComment({
			reason: 'vercel_bypass_missing',
			previewUrl: 'https://preview-abc.vercel.app',
		})
		expect(body.split('\n')[0]).toBe(
			'instrumentation gap: preview auth failed — vercel_bypass_missing',
		)
	})

	it('names the preview URL so reviewers can re-run by hand', () => {
		const body = formatInstrumentationGapComment({
			reason: 'vercel_bypass_invalid',
			previewUrl: 'https://preview-xyz.vercel.app/some/path',
		})
		expect(body).toContain('Preview URL: https://preview-xyz.vercel.app/some/path')
	})

	it('states no evidence comment was posted, so reviewers do not look for one', () => {
		const body = formatInstrumentationGapComment({
			reason: 'vercel_bypass_invalid',
			previewUrl: 'https://x',
		})
		expect(body).toContain('No evidence comment has been posted on this bet for this session.')
	})
})

describe('abortBetQa (unit)', () => {
	it('does nothing when the response looks authenticated', async () => {
		const events: string[] = []
		const comments: Array<{ betId: string; body: string }> = []
		const result = await abortBetQa(
			{
				previewUrl: 'https://x',
				sessionId: 'sess',
				betId: 'bet',
				bypassSecret: 'good',
				response: { status: 200, headers: {}, bodyText: '<html>ok</html>' },
				now: FROZEN_NOW,
			},
			{
				emitEvent: (line) => {
					events.push(line)
				},
				postComment: (input) => {
					comments.push(input)
				},
			},
		)
		expect(result).toEqual({ aborted: false })
		expect(events).toEqual([])
		expect(comments).toEqual([])
	})

	it('emits the event and posts the comment when the bypass is rejected', async () => {
		const events: string[] = []
		const comments: Array<{ betId: string; body: string }> = []
		const result = await abortBetQa(
			{
				previewUrl: 'https://preview-xyz.vercel.app',
				sessionId: 'sess-1',
				betId: 'bet-1',
				bypassSecret: 'wrong',
				response: {
					status: 401,
					headers: { 'content-type': 'text/html' },
					bodyText: 'Authentication Required',
				},
				now: FROZEN_NOW,
			},
			{
				emitEvent: (line) => {
					events.push(line)
				},
				postComment: (input) => {
					comments.push(input)
				},
			},
		)

		expect(result.aborted).toBe(true)
		if (!result.aborted) return
		expect(result.reason).toBe('vercel_bypass_invalid')
		expect(events).toHaveLength(1)
		expect(events[0]).toBe(result.eventLine)
		expect(comments).toEqual([
			{
				betId: 'bet-1',
				body: result.commentBody,
			},
		])
		expect(
			comments[0].body.startsWith(
				'instrumentation gap: preview auth failed — vercel_bypass_invalid',
			),
		).toBe(true)
	})
})

describe('abortBetQa (integration with a simulated bad secret) — AC-T3', () => {
	let serverUrl: string
	let lastReceivedBypassHeader: string | null = null

	const server = createServer((req, res) => {
		lastReceivedBypassHeader = (req.headers['x-vercel-protection-bypass'] as string) ?? null
		const accepted = lastReceivedBypassHeader === 'the-only-valid-secret'
		if (accepted) {
			res.writeHead(200, { 'content-type': 'text/html' })
			res.end('<html>app shell</html>')
			return
		}
		// Mirror Vercel's deployment-protection challenge: 401 + sso nonce cookie + auth-required body.
		res.writeHead(401, {
			'content-type': 'text/html',
			'set-cookie': '_vercel_sso_nonce=challenge; Path=/; HttpOnly',
		})
		res.end('<html><body>Authentication Required</body></html>')
	})

	beforeAll(async () => {
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		const addr = server.address() as AddressInfo
		serverUrl = `http://127.0.0.1:${addr.port}/`
	})

	afterAll(async () => {
		await new Promise<void>((resolve, reject) =>
			server.close((err) => (err ? reject(err) : resolve())),
		)
	})

	async function probePreview(url: string, secret: string | undefined) {
		const headers: Record<string, string> = {}
		if (secret) {
			headers['x-vercel-protection-bypass'] = secret
			headers['x-vercel-set-bypass-cookie'] = 'true'
		}
		const res = await fetch(url, { headers })
		const bodyText = await res.text()
		const out: Record<string, string> = {}
		res.headers.forEach((v, k) => {
			out[k] = v
		})
		return { status: res.status, headers: out, bodyText }
	}

	it('aborts with vercel_bypass_invalid + emits structured event + posts comment when secret is wrong', async () => {
		const response = await probePreview(serverUrl, 'a-wrong-secret')
		expect(lastReceivedBypassHeader).toBe('a-wrong-secret')

		const emittedLines: string[] = []
		const postedComments: Array<{ betId: string; body: string }> = []

		const result = await abortBetQa(
			{
				previewUrl: serverUrl,
				sessionId: 'sess-int-1',
				betId: 'bet-int-1',
				bypassSecret: 'a-wrong-secret',
				response,
				now: FROZEN_NOW,
			},
			{
				emitEvent: (line) => {
					emittedLines.push(line)
				},
				postComment: (input) => {
					postedComments.push(input)
				},
			},
		)

		expect(result.aborted).toBe(true)
		if (!result.aborted) return
		expect(result.reason).toBe('vercel_bypass_invalid')

		expect(emittedLines).toHaveLength(1)
		const line = emittedLines[0]
		expect(line.startsWith(BET_QA_EVENT_PREFIX)).toBe(true)
		expect(line.endsWith('\n')).toBe(true)
		const parsed = JSON.parse(line.slice(BET_QA_EVENT_PREFIX.length + 1).trimEnd())
		expect(parsed).toMatchObject({
			event: 'bet_qa_aborted',
			reason: 'vercel_bypass_invalid',
			previewUrl: serverUrl,
			sessionId: 'sess-int-1',
			betId: 'bet-int-1',
		})

		expect(postedComments).toHaveLength(1)
		expect(postedComments[0].betId).toBe('bet-int-1')
		expect(postedComments[0].body.split('\n')[0]).toBe(
			'instrumentation gap: preview auth failed — vercel_bypass_invalid',
		)
		expect(postedComments[0].body).toContain('No evidence comment has been posted')
	})

	it('aborts with vercel_bypass_missing + emits + posts when secret is absent', async () => {
		const response = await probePreview(serverUrl, undefined)
		expect(lastReceivedBypassHeader).toBeNull()

		const emittedLines: string[] = []
		const postedComments: Array<{ betId: string; body: string }> = []

		const result = await abortBetQa(
			{
				previewUrl: serverUrl,
				sessionId: 'sess-int-2',
				betId: 'bet-int-2',
				bypassSecret: undefined,
				response,
				now: FROZEN_NOW,
			},
			{
				emitEvent: (line) => {
					emittedLines.push(line)
				},
				postComment: (input) => {
					postedComments.push(input)
				},
			},
		)

		expect(result.aborted).toBe(true)
		if (!result.aborted) return
		expect(result.reason).toBe('vercel_bypass_missing')
		expect(emittedLines).toHaveLength(1)
		expect(postedComments).toHaveLength(1)
		expect(postedComments[0].body.split('\n')[0]).toBe(
			'instrumentation gap: preview auth failed — vercel_bypass_missing',
		)
	})

	it('returns aborted=false and posts NO comment when the bypass is honoured (no fabricated abort)', async () => {
		const response = await probePreview(serverUrl, 'the-only-valid-secret')
		expect(lastReceivedBypassHeader).toBe('the-only-valid-secret')

		const emittedLines: string[] = []
		const postedComments: Array<{ betId: string; body: string }> = []

		const result = await abortBetQa(
			{
				previewUrl: serverUrl,
				sessionId: 'sess-int-3',
				betId: 'bet-int-3',
				bypassSecret: 'the-only-valid-secret',
				response,
				now: FROZEN_NOW,
			},
			{
				emitEvent: (line) => {
					emittedLines.push(line)
				},
				postComment: (input) => {
					postedComments.push(input)
				},
			},
		)

		expect(result).toEqual({ aborted: false })
		expect(emittedLines).toEqual([])
		expect(postedComments).toEqual([])
	})
})
