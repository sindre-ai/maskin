import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
	type SessionGithubInstall,
	SessionGithubLogClassifier,
} from '../../../../lib/integrations/providers/github/log-classifier'
import { TOKEN_STALE_THRESHOLD_MS } from '../../../../lib/integrations/providers/github/token-metadata'

// `mintedAt` is anchored to the current test-run wallclock rather than a
// fixed date so a fresh install stays fresh regardless of when the suite
// runs (the classifier calls `new Date()` internally to compare token age).
function makeInstall(overrides: Partial<SessionGithubInstall> = {}): SessionGithubInstall {
	return {
		ownerLoginLower: 'sindre-ai',
		installationId: '4711',
		tokenMetadata: {
			token: 'ghs_fresh',
			installationId: '4711',
			mintedAt: new Date(Date.now() - 60_000),
		},
		...overrides,
	}
}

function toolUseLine(toolUseId: string, name: string): string {
	return JSON.stringify({
		type: 'assistant',
		message: {
			content: [
				{
					type: 'tool_use',
					id: toolUseId,
					name,
					input: {},
				},
			],
		},
	})
}

function toolResultLine(
	toolUseId: string,
	body: string,
	opts: { isError?: boolean } = { isError: true },
): string {
	return JSON.stringify({
		type: 'user',
		message: {
			content: [
				{
					type: 'tool_result',
					tool_use_id: toolUseId,
					content: body,
					is_error: opts.isError !== false,
				},
			],
		},
	})
}

describe('SessionGithubLogClassifier — no-op paths', () => {
	let classifier: SessionGithubLogClassifier

	beforeEach(() => {
		classifier = new SessionGithubLogClassifier(async () => true)
	})

	it('returns null when the session is not registered', async () => {
		const out = await classifier.classifyLine(
			'unknown-session',
			toolUseLine('toolu_1', 'mcp__github-sindre-ai__get_issue'),
		)
		expect(out).toBeNull()
	})

	it('returns null for non-JSON lines', async () => {
		classifier.registerSession('sess', [makeInstall()])
		expect(await classifier.classifyLine('sess', 'plain text log line')).toBeNull()
		expect(await classifier.classifyLine('sess', '')).toBeNull()
		expect(await classifier.classifyLine('sess', '{invalid')).toBeNull()
	})

	it('returns null for envelopes without tool_use / tool_result', async () => {
		classifier.registerSession('sess', [makeInstall()])
		expect(
			await classifier.classifyLine(
				'sess',
				JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }),
			),
		).toBeNull()
		expect(
			await classifier.classifyLine(
				'sess',
				JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
			),
		).toBeNull()
	})

	it('returns null for a successful github tool_result', async () => {
		classifier.registerSession('sess', [makeInstall()])
		await classifier.classifyLine(
			'sess',
			toolUseLine('toolu_ok', 'mcp__github-sindre-ai__list_issues'),
		)
		const out = await classifier.classifyLine(
			'sess',
			toolResultLine('toolu_ok', '[]', { isError: false }),
		)
		expect(out).toBeNull()
	})

	it('returns null for a non-github MCP tool failure', async () => {
		classifier.registerSession('sess', [makeInstall()])
		await classifier.classifyLine(
			'sess',
			toolUseLine('toolu_slack', 'mcp__integration-slack__send_message'),
		)
		const out = await classifier.classifyLine(
			'sess',
			toolResultLine('toolu_slack', 'channel_not_found'),
		)
		expect(out).toBeNull()
	})

	it('returns null when the tool_result arrives before the matching tool_use', async () => {
		classifier.registerSession('sess', [makeInstall()])
		const out = await classifier.classifyLine(
			'sess',
			toolResultLine('toolu_stray', 'HTTP 500 server error'),
		)
		expect(out).toBeNull()
	})
})

describe('SessionGithubLogClassifier — fault-injection: distinct tags land', () => {
	// One classifier + one session for the whole suite. Each test drives a
	// tool_use → failing tool_result pair, mirroring what a seeded fault-
	// injection run against a real agent would emit in the ingested session
	// log — the parent bet's AC-6 acceptance test.
	const install = makeInstall()
	const staleInstall = makeInstall({
		ownerLoginLower: 'churned-org',
		installationId: '9999',
		tokenMetadata: {
			token: 'ghs_stale',
			installationId: '9999',
			mintedAt: new Date(Date.now() - TOKEN_STALE_THRESHOLD_MS - 60_000),
		},
	})

	async function runFault(
		classifier: SessionGithubLogClassifier,
		toolUseId: string,
		toolName: string,
		body: string,
	) {
		await classifier.classifyLine('sess', toolUseLine(toolUseId, toolName))
		return classifier.classifyLine('sess', toolResultLine(toolUseId, body))
	}

	it('lands 401-unauth, 403-permission, schema-validation, token-expired-mid-session, and missing-token in one session', async () => {
		const classifier = new SessionGithubLogClassifier(async () => true)
		classifier.registerSession('sess', [install, staleInstall])

		const bad401 = await runFault(
			classifier,
			'toolu_401',
			'mcp__github-sindre-ai__get_issue',
			'GitHub API 401: Bad credentials',
		)
		expect(bad401?.classified.cause_tag).toBe('401-unauth')
		expect(bad401?.classified.installation_id).toBe('4711')
		expect(bad401?.taggedLine).toContain('cause_tag=401-unauth')
		expect(bad401?.taggedLine).toContain('tool=mcp__github-sindre-ai__get_issue')

		const bad403 = await runFault(
			classifier,
			'toolu_403',
			'mcp__github-sindre-ai__merge_pull_request',
			'GitHub API 403: Resource not accessible by integration',
		)
		expect(bad403?.classified.cause_tag).toBe('403-permission')

		const bad422 = await runFault(
			classifier,
			'toolu_422',
			'mcp__github-sindre-ai__create_pull_request_review',
			'GitHub API 422: Validation Failed — expected number for pull_number',
		)
		expect(bad422?.classified.cause_tag).toBe('schema-validation')

		// Stale-token install → 401 → the classifier's own resolveInstallation probe
		// says the ID still resolves, so the tag comes from the token-age signal
		// rather than the install churn signal.
		const stale = await runFault(
			classifier,
			'toolu_stale',
			'mcp__github-churned-org__push_files',
			'GitHub API 401: Bad credentials',
		)
		expect(stale?.classified.cause_tag).toBe('token-expired-mid-session')
		expect(stale?.classified.installation_id).toBe('9999')

		// tool_result for an owner the session doesn't know about (e.g. an install
		// that never resolved, or a tool call against a stale server entry) →
		// `hadToken: false` → `missing-token`.
		const missing = await runFault(
			classifier,
			'toolu_missing',
			'mcp__github-unknown-org__list_issues',
			'GitHub API 401: Bad credentials',
		)
		expect(missing?.classified.cause_tag).toBe('missing-token')

		const distinctTags = new Set(
			[bad401, bad403, bad422, stale, missing].map((r) => r?.classified.cause_tag),
		)
		expect(distinctTags.size).toBeGreaterThanOrEqual(4)
		expect(distinctTags).toContain('token-expired-mid-session')
	})

	it('tags 401 as token-expired-mid-session when the install-ID no longer resolves', async () => {
		const classifier = new SessionGithubLogClassifier(async () => false)
		classifier.registerSession('sess', [install])

		const out = await runFault(
			classifier,
			'toolu_churn',
			'mcp__github-sindre-ai__push_files',
			'GitHub API 401: Bad credentials',
		)
		expect(out?.classified.cause_tag).toBe('token-expired-mid-session')
	})

	it('does not run the resolve probe when the failure was not a 401', async () => {
		const probe = vi.fn(async () => true)
		const classifier = new SessionGithubLogClassifier(probe)
		classifier.registerSession('sess', [install])

		await runFault(
			classifier,
			'toolu_403',
			'mcp__github-sindre-ai__merge_pull_request',
			'GitHub API 403: Resource not accessible by integration',
		)
		expect(probe).not.toHaveBeenCalled()
	})

	it('falls back to install-churn when the probe itself errors on a 401', async () => {
		const probe = vi.fn(async () => {
			throw new Error('network down')
		})
		const classifier = new SessionGithubLogClassifier(probe)
		classifier.registerSession('sess', [install])

		const out = await runFault(
			classifier,
			'toolu_probe_err',
			'mcp__github-sindre-ai__push_files',
			'GitHub API 401: Bad credentials',
		)
		expect(out?.classified.cause_tag).toBe('token-expired-mid-session')
	})

	it('accepts a structured tool_result content array (text blocks)', async () => {
		const classifier = new SessionGithubLogClassifier(async () => true)
		classifier.registerSession('sess', [install])

		await classifier.classifyLine(
			'sess',
			toolUseLine('toolu_arr', 'mcp__github-sindre-ai__get_issue'),
		)
		const line = JSON.stringify({
			type: 'user',
			message: {
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'toolu_arr',
						is_error: true,
						content: [
							{ type: 'text', text: 'GitHub API 401: Bad credentials' },
							{ type: 'text', text: 'try again later' },
						],
					},
				],
			},
		})
		const out = await classifier.classifyLine('sess', line)
		expect(out?.classified.cause_tag).toBe('401-unauth')
	})

	it('unregisterSession stops classification', async () => {
		const classifier = new SessionGithubLogClassifier(async () => true)
		classifier.registerSession('sess', [install])
		classifier.unregisterSession('sess')

		await classifier.classifyLine(
			'sess',
			toolUseLine('toolu_gone', 'mcp__github-sindre-ai__get_issue'),
		)
		const out = await classifier.classifyLine(
			'sess',
			toolResultLine('toolu_gone', 'GitHub API 401: Bad credentials'),
		)
		expect(out).toBeNull()
	})
})

describe('SessionGithubLogClassifier — resource discipline', () => {
	it('evicts oldest pending tool_use once the map is full', async () => {
		const classifier = new SessionGithubLogClassifier(async () => true)
		classifier.registerSession('sess', [makeInstall()])
		// Simulate a runaway agent — 600 tool_use envelopes with no matching
		// tool_result. Map is capped at 512; the earliest one must have been
		// evicted so its later tool_result can't classify.
		for (let i = 0; i < 600; i++) {
			await classifier.classifyLine(
				'sess',
				toolUseLine(`toolu_${i}`, 'mcp__github-sindre-ai__get_issue'),
			)
		}
		const evicted = await classifier.classifyLine(
			'sess',
			toolResultLine('toolu_0', 'GitHub API 401: Bad credentials'),
		)
		expect(evicted).toBeNull()
		const kept = await classifier.classifyLine(
			'sess',
			toolResultLine('toolu_599', 'GitHub API 401: Bad credentials'),
		)
		expect(kept?.classified.cause_tag).toBe('401-unauth')
	})
})
