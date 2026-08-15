import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
	TaggedGithubError,
	classifyGithubError,
	fromError,
	fromResponse,
	wrapGithubToolCall,
} from '../../../../lib/integrations/providers/github/error-tagger'
import { TOKEN_STALE_THRESHOLD_MS } from '../../../../lib/integrations/providers/github/token-metadata'
import { logger } from '../../../../lib/logger'

function makeHeaders(record: Record<string, string>): Headers {
	return new Headers(record)
}

const now = new Date('2026-07-13T12:00:00.000Z')
const freshToken = {
	token: 'ghs_fresh',
	installationId: '4711',
	mintedAt: new Date(now.getTime() - 60_000),
}
const staleToken = {
	token: 'ghs_stale',
	installationId: '4711',
	mintedAt: new Date(now.getTime() - TOKEN_STALE_THRESHOLD_MS - 60_000),
}

describe('classifyGithubError — primary tag', () => {
	it('tags missing-token when no token was attached', () => {
		const out = classifyGithubError(
			{ hadToken: false, status: 401, body: 'Requires authentication' },
			{ now },
		)
		expect(out.cause_tag).toBe('missing-token')
	})

	it('tags anon-rate-limit when the anon per-IP quota is hit', () => {
		const out = classifyGithubError(
			{
				hadToken: true,
				status: 403,
				body: 'API rate limit exceeded for 203.0.113.1',
				headers: makeHeaders({
					'x-ratelimit-limit': '60',
					'x-ratelimit-remaining': '0',
				}),
			},
			{ now },
		)
		expect(out.cause_tag).toBe('anon-rate-limit')
	})

	it('tags schema-validation on 422', () => {
		const out = classifyGithubError(
			{
				hadToken: true,
				status: 422,
				body: 'pull_number: expected number, received string',
			},
			{ now },
		)
		expect(out.cause_tag).toBe('schema-validation')
	})

	it('tags schema-validation when body has zod hints even without 422', () => {
		const out = classifyGithubError(
			{
				hadToken: true,
				errorMessage: 'invalid_type: expected number, received string at pull_number',
			},
			{ now },
		)
		expect(out.cause_tag).toBe('schema-validation')
	})

	it('tags mergeable-blocked on 409 with mergeability hints', () => {
		const out = classifyGithubError(
			{
				hadToken: true,
				status: 409,
				body: '{"message":"Pull Request is not mergeable","mergeable_state":"dirty"}',
			},
			{ now },
		)
		expect(out.cause_tag).toBe('mergeable-blocked')
	})

	it('tags 401-unauth on a plain 401 with a fresh token', () => {
		const out = classifyGithubError(
			{ hadToken: true, status: 401, body: 'Bad credentials' },
			{ tokenMeta: freshToken, now },
		)
		expect(out.cause_tag).toBe('401-unauth')
	})

	it('tags 403-permission on a plain 403 without anon rate-limit shape', () => {
		const out = classifyGithubError(
			{ hadToken: true, status: 403, body: 'Resource not accessible by integration' },
			{ now },
		)
		expect(out.cause_tag).toBe('403-permission')
	})
})

describe('classifyGithubError — token-expired-mid-session', () => {
	it('picks token-expired-mid-session on 401 when the stamped token is older than 50 minutes', () => {
		const out = classifyGithubError(
			{ hadToken: true, status: 401, body: 'Bad credentials' },
			{ tokenMeta: staleToken, now },
		)
		expect(out.cause_tag).toBe('token-expired-mid-session')
		expect(out.installation_id).toBe('4711')
		expect(out.mint_age_seconds).toBeGreaterThan(50 * 60)
	})

	it('picks token-expired-mid-session on 401 when the installation ID no longer resolves', () => {
		const out = classifyGithubError(
			{ hadToken: true, status: 401, body: 'Bad credentials' },
			{ tokenMeta: freshToken, installationResolves: false, now },
		)
		expect(out.cause_tag).toBe('token-expired-mid-session')
	})

	it('falls back to 401-unauth when a fresh token 401s and the install still resolves', () => {
		const out = classifyGithubError(
			{ hadToken: true, status: 401, body: 'Bad credentials' },
			{ tokenMeta: freshToken, installationResolves: true, now },
		)
		expect(out.cause_tag).toBe('401-unauth')
	})
})

describe('classifyGithubError — secondary cause', () => {
	it('records a secondary_cause when a distinct second signal also fires', () => {
		const out = classifyGithubError(
			{
				hadToken: true,
				status: 409,
				body: 'mergeable_state: dirty — also received expected number at pull_number',
			},
			{ now },
		)
		expect(out.cause_tag).toBe('mergeable-blocked')
		expect(out.secondary_cause).toBe('schema-validation')
	})

	it('records token-expired-mid-session as secondary under an unrelated primary', () => {
		const out = classifyGithubError(
			{
				hadToken: true,
				status: 401,
				body: 'Bad credentials — also matched pull_number expected number',
			},
			{ tokenMeta: staleToken, now },
		)
		expect(out.cause_tag).toBe('token-expired-mid-session')
		expect(out.secondary_cause).toBe('schema-validation')
	})

	it('leaves secondary_cause unset when only one signal fires', () => {
		const out = classifyGithubError(
			{ hadToken: true, status: 403, body: 'Resource not accessible by integration' },
			{ now },
		)
		expect(out.secondary_cause).toBeUndefined()
	})
})

describe('fromResponse / fromError', () => {
	it('fromResponse fills status, body, and headers from a fetch Response', async () => {
		const res = new Response('Bad credentials', {
			status: 401,
			headers: { 'x-ratelimit-limit': '5000' },
		})
		const failure = await fromResponse(res, { hadToken: true })
		expect(failure.status).toBe(401)
		expect(failure.body).toBe('Bad credentials')
		expect(failure.headers?.get('x-ratelimit-limit')).toBe('5000')
	})

	it('fromResponse truncates oversize bodies', async () => {
		const big = 'x'.repeat(5000)
		const res = new Response(big, { status: 500 })
		const failure = await fromResponse(res, { hadToken: true, bodyLimit: 100 })
		expect(failure.body?.length).toBe(100)
	})

	it('fromError pulls status out of an Error message', () => {
		const err = new Error('Failed to get installation access token: 401 Bad credentials')
		const failure = fromError(err, { hadToken: true })
		expect(failure.status).toBe(401)
		expect(failure.errorMessage).toContain('Bad credentials')
	})
})

describe('wrapGithubToolCall', () => {
	beforeEach(() => {
		vi.mocked(logger.error).mockClear()
	})

	it('returns the value when the call succeeds', async () => {
		const out = await wrapGithubToolCall(() => Promise.resolve('ok'), {
			toolName: 'merge_pull_request',
			hadToken: true,
		})
		expect(out).toBe('ok')
		expect(logger.error).not.toHaveBeenCalled()
	})

	it('classifies and rethrows a TaggedGithubError on failure', async () => {
		const inner = new Error('Failed to merge: 409 mergeable_state: blocked')
		await expect(
			wrapGithubToolCall(() => Promise.reject(inner), {
				toolName: 'merge_pull_request',
				hadToken: true,
			}),
		).rejects.toMatchObject({
			name: 'TaggedGithubError',
			cause_tag: 'mergeable-blocked',
		})
		expect(logger.error).toHaveBeenCalledWith(
			'github tool call failed',
			expect.objectContaining({
				tool: 'merge_pull_request',
				cause_tag: 'mergeable-blocked',
			}),
		)
	})

	it('resolves installation on 401 and tags token-expired-mid-session when it no longer resolves', async () => {
		const inner = new Error('401 Bad credentials')
		const resolveInstallation = vi.fn().mockResolvedValue(false)
		await expect(
			wrapGithubToolCall(() => Promise.reject(inner), {
				toolName: 'approve_pull_request',
				hadToken: true,
				tokenMeta: freshToken,
				resolveInstallation,
			}),
		).rejects.toMatchObject({ cause_tag: 'token-expired-mid-session' })
		expect(resolveInstallation).toHaveBeenCalledWith('4711')
	})

	it('treats a 401 from the installation-resolve probe as install-gone', async () => {
		const inner = new Error('401 Bad credentials')
		const resolveInstallation = vi.fn().mockRejectedValue(new Error('boom'))
		await expect(
			wrapGithubToolCall(() => Promise.reject(inner), {
				toolName: 'approve_pull_request',
				hadToken: true,
				tokenMeta: freshToken,
				resolveInstallation,
			}),
		).rejects.toMatchObject({ cause_tag: 'token-expired-mid-session' })
	})

	it('keeps the original error accessible via TaggedGithubError.cause', async () => {
		const inner = new Error('403 forbidden')
		try {
			await wrapGithubToolCall(() => Promise.reject(inner), {
				toolName: 'create_pull_request',
				hadToken: true,
			})
			expect.fail('should have thrown')
		} catch (err) {
			expect(err).toBeInstanceOf(TaggedGithubError)
			expect((err as TaggedGithubError).cause).toBe(inner)
		}
	})
})
