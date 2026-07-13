import { describe, expect, it, vi } from 'vitest'
import {
	TOKEN_EXPIRY_THRESHOLD_MS,
	attachTag,
	classifyGithubFailure,
	classifyGithubFailureAsync,
	extractSignalFromError,
	wrapGithubToolCall,
} from '../../../../lib/integrations/providers/github/error-tagger'

// Mock the auth module so probeInstallationResolves doesn't hit the network.
vi.mock('../../../../lib/integrations/providers/github/auth', () => ({
	fetchInstallationOwnerLogin: vi.fn(),
}))
import { fetchInstallationOwnerLogin } from '../../../../lib/integrations/providers/github/auth'

// Silence logger to keep test output clean.
vi.mock('../../../../lib/logger', () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
import { logger } from '../../../../lib/logger'

// Anchor to real time so tests that don't inject `now` (e.g. wrapGithubToolCall,
// which reads Date.now() directly) still see a plausible mint-age.
const NOW = Date.now()
const FRESH_TOKEN = { mintedAt: NOW - 60_000, installationId: 'inst-42' }
const OLD_TOKEN = {
	mintedAt: NOW - (TOKEN_EXPIRY_THRESHOLD_MS + 60_000),
	installationId: 'inst-42',
}

describe('classifyGithubFailure', () => {
	it('tags missing-token when hadToken=false', () => {
		const tag = classifyGithubFailure({ status: 401, hadToken: false, body: 'Unauthorized' })
		expect(tag.cause).toBe('missing-token')
	})

	it('tags anon-rate-limit when body says rate limit and ceiling is 60', () => {
		const tag = classifyGithubFailure({
			status: 403,
			body: 'API rate limit exceeded for 8.8.8.8. (Anonymous)',
			headers: { 'x-ratelimit-limit': '60' },
		})
		expect(tag.cause).toBe('anon-rate-limit')
	})

	it('tags schema-validation on 422', () => {
		const tag = classifyGithubFailure({
			status: 422,
			body: '{"message":"Validation Failed","errors":[{"message":"pull_number: expected number, received string"}]}',
		})
		expect(tag.cause).toBe('schema-validation')
	})

	it('tags schema-validation when body carries validation shape even without status', () => {
		const tag = classifyGithubFailure({
			body: 'pull_number: expected number, received string',
		})
		expect(tag.cause).toBe('schema-validation')
	})

	it('tags mergeable-blocked when body says mergeable_state=blocked', () => {
		const tag = classifyGithubFailure({
			status: 405,
			body: '{"message":"Not mergeable","mergeable_state":"blocked"}',
		})
		expect(tag.cause).toBe('mergeable-blocked')
	})

	it('tags mergeable-blocked on 409 with required check message', () => {
		const tag = classifyGithubFailure({
			status: 409,
			body: 'required status check "ci" is pending; mergeable_state: unstable',
		})
		expect(tag.cause).toBe('mergeable-blocked')
	})

	it('tags token-expired-mid-session when 401 and mint-age exceeds threshold', () => {
		const tag = classifyGithubFailure({
			status: 401,
			body: 'Bad credentials',
			tokenContext: OLD_TOKEN,
			hadToken: true,
			now: NOW,
		})
		expect(tag.cause).toBe('token-expired-mid-session')
		expect(tag.reason).toMatch(/mint-age/)
	})

	it('tags token-expired-mid-session when installation ID no longer resolves', () => {
		const tag = classifyGithubFailure(
			{
				status: 401,
				body: 'Bad credentials',
				tokenContext: FRESH_TOKEN,
				hadToken: true,
				now: NOW,
			},
			false, // installation does not resolve
		)
		expect(tag.cause).toBe('token-expired-mid-session')
		expect(tag.reason).toMatch(/no longer resolves/)
	})

	it('falls back to 401-unauth when 401 but token is fresh and installation still resolves', () => {
		const tag = classifyGithubFailure(
			{
				status: 401,
				body: 'Bad credentials',
				tokenContext: FRESH_TOKEN,
				hadToken: true,
				now: NOW,
			},
			true,
		)
		expect(tag.cause).toBe('401-unauth')
	})

	it('tags 401-unauth on 401 with no token context (cannot distinguish expiry)', () => {
		const tag = classifyGithubFailure({ status: 401, body: 'Unauthorized', hadToken: true })
		expect(tag.cause).toBe('401-unauth')
	})

	it('tags 403-permission on 403 that is not a rate-limit', () => {
		const tag = classifyGithubFailure({
			status: 403,
			body: 'Resource not accessible by integration',
			hadToken: true,
		})
		expect(tag.cause).toBe('403-permission')
	})

	it('records anon-rate-limit as secondary_cause when token-expired-mid-session AND body has rate-limit signal AND anon ceiling', () => {
		const tag = classifyGithubFailure({
			status: 401,
			body: 'Bad credentials — API rate limit exceeded',
			headers: { 'x-ratelimit-limit': '60' },
			tokenContext: OLD_TOKEN,
			hadToken: true,
			now: NOW,
		})
		expect(tag.cause).toBe('token-expired-mid-session')
		expect(tag.secondary_cause).toBe('anon-rate-limit')
	})

	it('leaves secondary_cause undefined when rate-limit body is on authenticated ceiling (5000)', () => {
		const tag = classifyGithubFailure({
			status: 401,
			body: 'Bad credentials — API rate limit exceeded',
			headers: { 'x-ratelimit-limit': '5000' },
			tokenContext: OLD_TOKEN,
			hadToken: true,
			now: NOW,
		})
		expect(tag.cause).toBe('token-expired-mid-session')
		expect(tag.secondary_cause).toBeUndefined()
	})

	it('records secondary_cause on a plain 401-unauth when body also has rate-limit + anon ceiling', () => {
		const tag = classifyGithubFailure(
			{
				status: 401,
				body: 'Bad credentials — API rate limit exceeded',
				headers: { 'x-ratelimit-limit': '60' },
				tokenContext: FRESH_TOKEN,
				hadToken: true,
				now: NOW,
			},
			true,
		)
		expect(tag.cause).toBe('401-unauth')
		expect(tag.secondary_cause).toBe('anon-rate-limit')
	})

	it('tags 403-permission (not anon) when a 403 body carries rate-limit text but no anon ceiling', () => {
		const tag = classifyGithubFailure({
			status: 403,
			body: 'API rate limit exceeded — secondary rate limit for user X',
			headers: { 'x-ratelimit-limit': '5000' },
			hadToken: true,
		})
		expect(tag.cause).toBe('403-permission')
		expect(tag.secondary_cause).toBeUndefined()
	})

	it('redacts GitHub-shaped tokens (ghs_, ghp_) from the logged reason', () => {
		const tag = classifyGithubFailure({
			status: 401,
			body: 'Bad credentials — token ghs_abcdefghijklmnop123456 rejected',
			hadToken: true,
		})
		expect(tag.cause).toBe('401-unauth')
		expect(tag.reason).not.toContain('ghs_abcdefghijklmnop')
		expect(tag.reason).toContain('[REDACTED_TOKEN]')
	})

	it('never leaves a failure untagged — falls back to 401-unauth with reason', () => {
		const tag = classifyGithubFailure({ status: 500, body: 'internal server error' })
		expect(tag.cause).toBe('401-unauth')
		expect(tag.reason).toMatch(/unclassified/)
	})

	it('rate-limit body without ceiling header and unknown hadToken is NOT anon (avoids false positive)', () => {
		const tag = classifyGithubFailure({
			status: 403,
			body: 'API rate limit exceeded — secondary rate limit',
		})
		// Should fall through to 403-permission, not anon.
		expect(tag.cause).toBe('403-permission')
	})
})

describe('classifyGithubFailureAsync — installation-ID churn probe', () => {
	it('probes installation when 401 and mint-age under threshold', async () => {
		vi.mocked(fetchInstallationOwnerLogin).mockRejectedValueOnce(
			new Error('Failed to fetch installation owner: 404 Not Found'),
		)
		const tag = await classifyGithubFailureAsync({
			status: 401,
			body: 'Bad credentials',
			tokenContext: FRESH_TOKEN,
			hadToken: true,
			now: NOW,
		})
		expect(fetchInstallationOwnerLogin).toHaveBeenCalledWith('inst-42')
		expect(tag.cause).toBe('token-expired-mid-session')
	})

	it('skips the probe when mint-age already crosses the threshold', async () => {
		vi.mocked(fetchInstallationOwnerLogin).mockClear()
		const tag = await classifyGithubFailureAsync({
			status: 401,
			body: 'Bad credentials',
			tokenContext: OLD_TOKEN,
			hadToken: true,
			now: NOW,
		})
		expect(fetchInstallationOwnerLogin).not.toHaveBeenCalled()
		expect(tag.cause).toBe('token-expired-mid-session')
	})

	it('skips the probe when not a 401', async () => {
		vi.mocked(fetchInstallationOwnerLogin).mockClear()
		const tag = await classifyGithubFailureAsync({
			status: 422,
			body: 'Validation Failed',
			tokenContext: FRESH_TOKEN,
		})
		expect(fetchInstallationOwnerLogin).not.toHaveBeenCalled()
		expect(tag.cause).toBe('schema-validation')
	})

	it('tags 401-unauth (not token-expired) when the probe succeeds', async () => {
		vi.mocked(fetchInstallationOwnerLogin).mockResolvedValueOnce('sindre-ai')
		const tag = await classifyGithubFailureAsync({
			status: 401,
			body: 'Bad credentials',
			tokenContext: FRESH_TOKEN,
			hadToken: true,
			now: NOW,
		})
		expect(tag.cause).toBe('401-unauth')
	})

	it('tags 401-unauth when the probe itself errors (network) — no false positive on token-expired', async () => {
		vi.mocked(fetchInstallationOwnerLogin).mockRejectedValueOnce(
			new Error('ECONNRESET: connection reset'),
		)
		const tag = await classifyGithubFailureAsync({
			status: 401,
			body: 'Bad credentials',
			tokenContext: FRESH_TOKEN,
			hadToken: true,
			now: NOW,
		})
		expect(tag.cause).toBe('401-unauth')
	})
})

describe('extractSignalFromError', () => {
	it('pulls status and body off a shaped error object', () => {
		const err = Object.assign(new Error('Bad credentials'), {
			status: 401,
			body: 'Bad credentials',
		})
		const sig = extractSignalFromError(err)
		expect(sig.status).toBe(401)
		expect(sig.body).toBe('Bad credentials')
	})

	it('falls back to error message when body is absent', () => {
		const sig = extractSignalFromError(new Error('Failed to get installation access token: 401'))
		expect(sig.body).toContain('401')
	})

	it('handles non-Error thrown values by stringifying', () => {
		const sig = extractSignalFromError('boom')
		expect(sig.body).toBe('boom')
	})
})

describe('attachTag', () => {
	it('attaches causeTag to the error object', () => {
		const err = new Error('boom')
		attachTag(err, { cause: '401-unauth', reason: 'x' })
		const tagged = err as Error & { causeTag: { cause: string } }
		expect(tagged.causeTag.cause).toBe('401-unauth')
	})
})

describe('wrapGithubToolCall', () => {
	it('passes through the result on success', async () => {
		const result = await wrapGithubToolCall(
			{ toolName: 'get_pull_request', hadToken: true, tokenContext: FRESH_TOKEN },
			async () => 'ok',
		)
		expect(result).toBe('ok')
	})

	it('classifies, logs, and rethrows a tagged error on failure', async () => {
		vi.mocked(logger.error).mockClear()
		vi.mocked(fetchInstallationOwnerLogin).mockResolvedValueOnce('sindre-ai')
		const err = Object.assign(new Error('Bad credentials'), {
			status: 401,
			body: 'Bad credentials',
		})
		await expect(
			wrapGithubToolCall(
				{ toolName: 'merge_pull_request', hadToken: true, tokenContext: FRESH_TOKEN },
				async () => {
					throw err
				},
			),
		).rejects.toThrow('Bad credentials')

		expect(logger.error).toHaveBeenCalledWith(
			'github tool call failed',
			expect.objectContaining({
				provider: 'github',
				tool_name: 'merge_pull_request',
				cause_tag: '401-unauth',
				installation_id: 'inst-42',
			}),
		)
		const tagged = err as Error & { causeTag: { cause: string } }
		expect(tagged.causeTag.cause).toBe('401-unauth')
	})

	it('tags a stale-token failure as token-expired-mid-session', async () => {
		vi.mocked(logger.error).mockClear()
		const err = Object.assign(new Error('Bad credentials'), {
			status: 401,
			body: 'Bad credentials',
		})
		await expect(
			wrapGithubToolCall(
				{ toolName: 'merge_pull_request', hadToken: true, tokenContext: OLD_TOKEN },
				async () => {
					throw err
				},
			),
		).rejects.toThrow()
		expect(logger.error).toHaveBeenCalledWith(
			'github tool call failed',
			expect.objectContaining({ cause_tag: 'token-expired-mid-session' }),
		)
	})

	it('tags missing-token when hadToken=false — takes priority over rate-limit body', async () => {
		vi.mocked(logger.error).mockClear()
		const err = Object.assign(new Error('rate limited'), {
			status: 403,
			body: 'API rate limit exceeded for 8.8.8.8',
			headers: { 'x-ratelimit-limit': '60' },
		})
		await expect(
			wrapGithubToolCall({ toolName: 'list_pull_requests', hadToken: false }, async () => {
				throw err
			}),
		).rejects.toThrow()
		expect(logger.error).toHaveBeenCalledWith(
			'github tool call failed',
			expect.objectContaining({ cause_tag: 'missing-token' }),
		)
	})
})
