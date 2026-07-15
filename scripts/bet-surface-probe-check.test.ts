import { describe, expect, it, vi } from 'vitest'
import {
	BET_ID_TRAILER_RE,
	type BetLookup,
	checkBets,
	evaluateBet,
	extractBetIds,
	fetchBet,
	parseArgs,
	requiresTrailer,
} from './bet-surface-probe-check'

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const UUID_C = '33333333-3333-4333-8333-333333333333'

const API_OPTS = {
	apiBase: 'https://maskin.example',
	apiKey: 'ank_test_key',
	workspaceId: '99999999-9999-4999-8999-999999999999',
}

function jsonResponse(
	body: unknown,
	init: { status?: number; statusText?: string } = {},
): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		statusText: init.statusText ?? 'OK',
		headers: { 'content-type': 'application/json' },
	})
}

describe('extractBetIds', () => {
	// The regex has the `g` flag, so its lastIndex is stateful. Prove the
	// extractor resets it — otherwise the second call in the same process
	// would silently skip trailers.
	it('is safe to call twice with different inputs', () => {
		expect(extractBetIds(`Bet-ID: ${UUID_A}`)).toEqual([UUID_A])
		expect(extractBetIds(`Bet-ID: ${UUID_B}`)).toEqual([UUID_B])
		BET_ID_TRAILER_RE.lastIndex = 0
	})

	it('extracts a single trailer', () => {
		const body = `Some PR summary\n\nBet-ID: ${UUID_A}\n`
		expect(extractBetIds(body)).toEqual([UUID_A])
	})

	it('extracts multiple trailers preserving order', () => {
		const body = `Bet-ID: ${UUID_B}\nother content\nBet-ID: ${UUID_A}\n`
		expect(extractBetIds(body)).toEqual([UUID_B, UUID_A])
	})

	it('dedupes case-insensitively and lowercases', () => {
		const body = `Bet-ID: ${UUID_A.toUpperCase()}\nBet-ID: ${UUID_A}\n`
		expect(extractBetIds(body)).toEqual([UUID_A])
	})

	it('ignores non-UUID values after the trailer key', () => {
		const body = 'Bet-ID: not-a-uuid\nBet-ID: 1234\n'
		expect(extractBetIds(body)).toEqual([])
	})

	it('returns empty on a body with no trailers', () => {
		expect(extractBetIds('nothing to see here')).toEqual([])
	})
})

describe('requiresTrailer', () => {
	it('is true for bet/ branches', () => {
		expect(requiresTrailer('bet/ci-surface-probe-gate')).toBe(true)
	})
	it('is false for other branches', () => {
		expect(requiresTrailer('main')).toBe(false)
		expect(requiresTrailer('task/foo')).toBe(false)
	})
	it('is false when no head branch is provided', () => {
		expect(requiresTrailer(undefined)).toBe(false)
	})
})

describe('evaluateBet', () => {
	function make(verdict: string | null, title: string | null = 'Test bet'): BetLookup {
		return { id: UUID_A, title, verdict }
	}

	it('passes on pass', () => {
		const r = evaluateBet(make('pass'))
		expect(r.ok).toBe(true)
		expect(r.line).toBe(`pass — bet Test bet (${UUID_A}): surface_probe_verdict=pass`)
	})

	it('passes on miss_resolved', () => {
		expect(evaluateBet(make('miss_resolved')).ok).toBe(true)
	})

	it('fails on unset (null metadata)', () => {
		const r = evaluateBet(make(null))
		expect(r.ok).toBe(false)
		expect(r.line).toContain('surface_probe_verdict=unset')
		expect(r.line).toContain('cannot advance to active/live')
	})

	it('fails on miss_open', () => {
		const r = evaluateBet(make('miss_open'))
		expect(r.ok).toBe(false)
		expect(r.line).toContain('surface_probe_verdict=miss_open')
	})

	it('fails on unverified', () => {
		expect(evaluateBet(make('unverified')).ok).toBe(false)
	})

	it('fails closed on an unknown verdict string', () => {
		const r = evaluateBet(make('shipped'))
		expect(r.ok).toBe(false)
		expect(r.line).toContain('unverified (raw=shipped)')
	})

	it('omits the title when it is null', () => {
		const r = evaluateBet(make('pass', null))
		expect(r.line).toBe(`pass — bet (${UUID_A}): surface_probe_verdict=pass`)
	})
})

describe('fetchBet', () => {
	it('sends bearer + workspace headers to the right URL', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse({ title: 'B', metadata: { surface_probe_verdict: 'pass' } }))
		const r = await fetchBet(UUID_A, { ...API_OPTS, fetchImpl })
		expect(r).toEqual({ kind: 'ok', bet: { id: UUID_A, title: 'B', verdict: 'pass' } })
		expect(fetchImpl).toHaveBeenCalledOnce()
		const [url, init] = fetchImpl.mock.calls[0] ?? []
		expect(url).toBe(`https://maskin.example/api/objects/${UUID_A}`)
		const headers = (init as RequestInit)?.headers as Record<string, string>
		expect(headers.Authorization).toBe(`Bearer ${API_OPTS.apiKey}`)
		expect(headers['X-Workspace-Id']).toBe(API_OPTS.workspaceId)
	})

	it('strips a trailing slash from apiBase', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse({ title: 'B', metadata: { surface_probe_verdict: 'pass' } }))
		await fetchBet(UUID_A, { ...API_OPTS, apiBase: 'https://maskin.example/', fetchImpl })
		const [url] = fetchImpl.mock.calls[0] ?? []
		expect(url).toBe(`https://maskin.example/api/objects/${UUID_A}`)
	})

	it('returns null verdict when metadata is missing', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse({ title: 'B', metadata: null }))
		const r = await fetchBet(UUID_A, { ...API_OPTS, fetchImpl })
		expect(r).toEqual({ kind: 'ok', bet: { id: UUID_A, title: 'B', verdict: null } })
	})

	it('returns unresolvable on 404', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response('{"error":"not found"}', { status: 404, statusText: 'Not Found' }),
			)
		const r = await fetchBet(UUID_A, { ...API_OPTS, fetchImpl })
		expect(r).toEqual({ kind: 'unresolvable', status: 404 })
	})

	it('returns api_error on 401', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response('unauthorized', { status: 401, statusText: 'Unauthorized' }))
		const r = await fetchBet(UUID_A, { ...API_OPTS, fetchImpl })
		expect(r.kind).toBe('api_error')
		if (r.kind === 'api_error') expect(r.detail).toContain('401 Unauthorized')
	})

	it('returns api_error on 500', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response('boom', { status: 500, statusText: 'Internal Server Error' }))
		const r = await fetchBet(UUID_A, { ...API_OPTS, fetchImpl })
		expect(r.kind).toBe('api_error')
		if (r.kind === 'api_error') expect(r.detail).toContain('500 Internal Server Error')
	})

	it('returns api_error on network failure', async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'))
		const r = await fetchBet(UUID_A, { ...API_OPTS, fetchImpl })
		expect(r).toEqual({ kind: 'api_error', detail: 'network error: ECONNREFUSED' })
	})
})

describe('checkBets', () => {
	it('passes when every bet is pass or miss_resolved', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse({ title: 'A', metadata: { surface_probe_verdict: 'pass' } }),
			)
			.mockResolvedValueOnce(
				jsonResponse({ title: 'B', metadata: { surface_probe_verdict: 'miss_resolved' } }),
			)
		const r = await checkBets([UUID_A, UUID_B], { ...API_OPTS, fetchImpl })
		expect(r.ok).toBe(true)
		expect(r.lines).toHaveLength(2)
		expect(r.lines[0]).toContain('pass — bet A')
		expect(r.lines[1]).toContain('pass — bet B')
	})

	it('fails when any bet is unset among passes (multi-bet mixed)', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse({ title: 'A', metadata: { surface_probe_verdict: 'pass' } }),
			)
			.mockResolvedValueOnce(jsonResponse({ title: 'B', metadata: {} })) // unset
			.mockResolvedValueOnce(
				jsonResponse({ title: 'C', metadata: { surface_probe_verdict: 'pass' } }),
			)
		const r = await checkBets([UUID_A, UUID_B, UUID_C], { ...API_OPTS, fetchImpl })
		expect(r.ok).toBe(false)
		expect(r.lines[0]).toMatch(/^pass — bet A/)
		expect(r.lines[1]).toMatch(/^fail — bet B .+surface_probe_verdict=unset/)
		expect(r.lines[2]).toMatch(/^pass — bet C/)
	})

	it('reports unresolvable on 404', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response('{}', { status: 404, statusText: 'Not Found' }))
		const r = await checkBets([UUID_A], { ...API_OPTS, fetchImpl })
		expect(r.ok).toBe(false)
		expect(r.lines[0]).toContain(`fail — bet (${UUID_A}): unresolvable (404)`)
	})

	it('fails closed on a 4xx API error', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response('nope', { status: 401, statusText: 'Unauthorized' }))
		const r = await checkBets([UUID_A], { ...API_OPTS, fetchImpl })
		expect(r.ok).toBe(false)
		expect(r.lines[0]).toContain('fail — cannot reach Maskin API for bet')
		expect(r.lines[0]).toContain('401 Unauthorized')
	})

	it('fails closed on a 5xx API error', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response('boom', { status: 502, statusText: 'Bad Gateway' }))
		const r = await checkBets([UUID_A], { ...API_OPTS, fetchImpl })
		expect(r.ok).toBe(false)
		expect(r.lines[0]).toContain('fail — cannot reach Maskin API for bet')
		expect(r.lines[0]).toContain('502 Bad Gateway')
	})

	it('checks each bet exactly once, in order', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse({ title: 'x', metadata: { surface_probe_verdict: 'pass' } }))
		await checkBets([UUID_A, UUID_B], { ...API_OPTS, fetchImpl })
		expect(fetchImpl).toHaveBeenCalledTimes(2)
		expect(fetchImpl.mock.calls[0]?.[0]).toBe(`https://maskin.example/api/objects/${UUID_A}`)
		expect(fetchImpl.mock.calls[1]?.[0]).toBe(`https://maskin.example/api/objects/${UUID_B}`)
	})
})

describe('parseArgs', () => {
	it('parses --bet flags (repeatable)', () => {
		const args = parseArgs(['--bet', UUID_A, '--bet', UUID_B])
		expect(args.bets).toEqual([UUID_A, UUID_B])
	})

	it('lowercases --bet values', () => {
		const args = parseArgs(['--bet', UUID_A.toUpperCase()])
		expect(args.bets).toEqual([UUID_A])
	})

	it('rejects a non-UUID --bet value', () => {
		expect(() => parseArgs(['--bet', 'not-a-uuid'])).toThrow(/not a UUID/)
	})

	it('parses --pr-body-file and --head-branch', () => {
		const args = parseArgs(['--pr-body-file', '/tmp/body', '--head-branch', 'bet/foo'])
		expect(args.prBodyFile).toBe('/tmp/body')
		expect(args.headBranch).toBe('bet/foo')
	})

	it('sets help on --help', () => {
		expect(parseArgs(['--help']).help).toBe(true)
		expect(parseArgs(['-h']).help).toBe(true)
	})

	it('throws on an unknown flag', () => {
		expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/)
	})

	it('throws on --bet missing value', () => {
		expect(() => parseArgs(['--bet'])).toThrow(/--bet requires/)
	})
})
