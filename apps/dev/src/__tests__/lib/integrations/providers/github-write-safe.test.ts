import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetValidToken = vi.fn()
vi.mock('../../../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: vi.fn().mockImplementation(() => ({
		getValidToken: mockGetValidToken,
	})),
}))

// Stub the registry so getProvider('github') returns something shaped like a
// resolved provider without pulling env-driven auth into unit-test scope.
vi.mock('../../../../lib/integrations/registry', () => ({
	getProvider: vi.fn().mockReturnValue({
		config: { name: 'github', displayName: 'GitHub', auth: { type: 'oauth2_custom' } },
		customAuth: {
			getInstallUrl: vi.fn(),
			handleCallback: vi.fn(),
			getAccessToken: vi.fn(),
		},
	}),
}))

import { performGithubWrite } from '../../../../lib/integrations/providers/github/write-safe'

function makeResponse(status: number, body = ''): Response {
	return new Response(body, { status })
}

describe('performGithubWrite', () => {
	const fetchMock = vi.fn()
	const db = {} as Parameters<typeof performGithubWrite>[0]

	beforeEach(() => {
		mockGetValidToken.mockReset()
		fetchMock.mockReset()
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('returns the response and mints once on the happy path', async () => {
		mockGetValidToken.mockResolvedValue('gh-token-1')
		fetchMock.mockResolvedValueOnce(makeResponse(200, '{"ok":true}'))

		const res = await performGithubWrite(db, 'integration-1', {
			url: 'https://api.github.com/repos/o/r/pulls/1/merge',
			method: 'PUT',
			body: { merge_method: 'squash' },
		})

		expect(res.status).toBe(200)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(mockGetValidToken).toHaveBeenCalledTimes(1)

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://api.github.com/repos/o/r/pulls/1/merge')
		expect(init.method).toBe('PUT')
		const headers = init.headers as Record<string, string>
		expect(headers.Authorization).toBe('Bearer gh-token-1')
		expect(headers['Content-Type']).toBe('application/json')
		expect(init.body).toBe('{"merge_method":"squash"}')
	})

	it('re-mints and retries exactly once on 401, returning the retry response', async () => {
		mockGetValidToken.mockResolvedValueOnce('stale-token').mockResolvedValueOnce('fresh-token')
		fetchMock
			.mockResolvedValueOnce(makeResponse(401, 'Bad credentials'))
			.mockResolvedValueOnce(makeResponse(200, '{"merged":true}'))

		const res = await performGithubWrite(db, 'integration-1', {
			url: 'https://api.github.com/repos/o/r/pulls/1/merge',
			method: 'PUT',
			body: { merge_method: 'squash' },
		})

		expect(res.status).toBe(200)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(mockGetValidToken).toHaveBeenCalledTimes(2)

		const firstAuth = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<
			string,
			string
		>
		const secondAuth = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<
			string,
			string
		>
		expect(firstAuth.Authorization).toBe('Bearer stale-token')
		expect(secondAuth.Authorization).toBe('Bearer fresh-token')
	})

	it('returns the second 401 as-is when the retry also fails', async () => {
		mockGetValidToken.mockResolvedValueOnce('stale-token').mockResolvedValueOnce('also-stale-token')
		fetchMock
			.mockResolvedValueOnce(makeResponse(401, 'Bad credentials'))
			.mockResolvedValueOnce(makeResponse(401, 'still bad credentials'))

		const res = await performGithubWrite(db, 'integration-1', {
			url: 'https://api.github.com/repos/o/r/pulls/1/merge',
			method: 'PUT',
			body: { merge_method: 'squash' },
		})

		expect(res.status).toBe(401)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(mockGetValidToken).toHaveBeenCalledTimes(2)
	})

	it('does not retry on non-401 responses', async () => {
		mockGetValidToken.mockResolvedValue('gh-token-1')
		fetchMock.mockResolvedValueOnce(makeResponse(422, 'validation error'))

		const res = await performGithubWrite(db, 'integration-1', {
			url: 'https://api.github.com/repos/o/r/pulls/1/merge',
			method: 'PUT',
			body: { merge_method: 'squash' },
		})

		expect(res.status).toBe(422)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(mockGetValidToken).toHaveBeenCalledTimes(1)
	})

	it('does not retry on 500 errors either', async () => {
		mockGetValidToken.mockResolvedValue('gh-token-1')
		fetchMock.mockResolvedValueOnce(makeResponse(500, 'server exploded'))

		const res = await performGithubWrite(db, 'integration-1', {
			url: 'https://api.github.com/repos/o/r/pulls/1/merge',
			method: 'PUT',
		})

		expect(res.status).toBe(500)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})
