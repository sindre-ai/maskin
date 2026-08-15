import { describe, expect, it, vi } from 'vitest'
import { fetchFitnessSignal } from '../lib/fitness.js'

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})
}

const baseOpts = {
	owner: 'sindre-ai',
	repo: 'maskin',
	sha: 'deadbeefcafebabe',
	token: 'ghs_test',
	pollIntervalMs: 1,
	pollTimeoutMs: 10,
}

describe('fetchFitnessSignal', () => {
	it('returns true when the maskin/fitness check-run conclusion is failure', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				check_runs: [{ name: 'maskin/fitness', status: 'completed', conclusion: 'failure' }],
			}),
		)
		const result = await fetchFitnessSignal({ ...baseOpts, fetchImpl })
		expect(result).toBe(true)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('returns false when the maskin/fitness check-run conclusion is success', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				check_runs: [{ name: 'maskin/fitness', status: 'completed', conclusion: 'success' }],
			}),
		)
		const result = await fetchFitnessSignal({ ...baseOpts, fetchImpl })
		expect(result).toBe(false)
	})

	it('returns false when the conclusion is neutral (fitness passed with no new violations)', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				check_runs: [{ name: 'maskin/fitness', status: 'completed', conclusion: 'neutral' }],
			}),
		)
		const result = await fetchFitnessSignal({ ...baseOpts, fetchImpl })
		expect(result).toBe(false)
	})

	it('polls until the check-run completes, then honors the conclusion', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ check_runs: [] }))
			.mockResolvedValueOnce(
				jsonResponse({
					check_runs: [{ name: 'maskin/fitness', status: 'in_progress', conclusion: null }],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					check_runs: [{ name: 'maskin/fitness', status: 'completed', conclusion: 'failure' }],
				}),
			)

		const result = await fetchFitnessSignal({
			...baseOpts,
			pollTimeoutMs: 1_000,
			fetchImpl,
			sleepImpl: async () => {},
		})
		expect(result).toBe(true)
		expect(fetchImpl).toHaveBeenCalledTimes(3)
	})

	it('fails closed (returns true) when polling times out without the check-run completing', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				check_runs: [{ name: 'maskin/fitness', status: 'queued', conclusion: null }],
			}),
		)
		// nowImpl advances past the deadline after the first check, forcing a fail-closed.
		let ticks = 0
		const nowImpl = () => {
			const t = ticks * 200
			ticks += 1
			return t
		}
		const result = await fetchFitnessSignal({
			...baseOpts,
			pollTimeoutMs: 100,
			fetchImpl,
			sleepImpl: async () => {},
			nowImpl,
		})
		expect(result).toBe(true)
	})

	it('fails closed when the GitHub API is unreachable (non-2xx response) beyond the poll window', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('gateway timeout', { status: 502 }))
		let ticks = 0
		const nowImpl = () => {
			const t = ticks * 200
			ticks += 1
			return t
		}
		const result = await fetchFitnessSignal({
			...baseOpts,
			pollTimeoutMs: 100,
			fetchImpl,
			sleepImpl: async () => {},
			nowImpl,
		})
		expect(result).toBe(true)
	})

	it('sends the required GitHub API headers (auth + api version)', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				check_runs: [{ name: 'maskin/fitness', status: 'completed', conclusion: 'success' }],
			}),
		)
		await fetchFitnessSignal({ ...baseOpts, fetchImpl })
		const [url, init] = fetchImpl.mock.calls[0]
		expect(url).toContain(
			'/repos/sindre-ai/maskin/commits/deadbeefcafebabe/check-runs?check_name=maskin%2Ffitness',
		)
		const headers = init.headers as Record<string, string>
		expect(headers.Authorization).toBe('Bearer ghs_test')
		expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
	})
})
