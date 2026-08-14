const FITNESS_CHECK_NAME = 'maskin/fitness'

export interface FetchFitnessSignalOptions {
	owner: string
	repo: string
	sha: string
	token: string
	pollTimeoutMs?: number
	pollIntervalMs?: number
	fetchImpl?: typeof fetch
	sleepImpl?: (ms: number) => Promise<void>
	nowImpl?: () => number
}

interface CheckRun {
	name: string
	status: string
	conclusion: string | null
}

interface CheckRunsResponse {
	check_runs?: CheckRun[]
}

export async function fetchFitnessSignal(opts: FetchFitnessSignalOptions): Promise<boolean> {
	const {
		owner,
		repo,
		sha,
		token,
		pollTimeoutMs = 120_000,
		pollIntervalMs = 10_000,
		fetchImpl = fetch,
		sleepImpl = defaultSleep,
		nowImpl = Date.now,
	} = opts

	const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/check-runs?check_name=${encodeURIComponent(FITNESS_CHECK_NAME)}&filter=latest`
	const deadline = nowImpl() + pollTimeoutMs

	while (true) {
		const run = await fetchLatestFitnessRun(url, token, fetchImpl)
		if (run && run.status === 'completed') {
			return run.conclusion === 'failure'
		}
		if (nowImpl() >= deadline) return true
		await sleepImpl(pollIntervalMs)
	}
}

async function fetchLatestFitnessRun(
	url: string,
	token: string,
	fetchImpl: typeof fetch,
): Promise<CheckRun | null> {
	const res = await fetchImpl(url, {
		headers: {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${token}`,
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'maskin-risk-classifier',
		},
	})
	if (!res.ok) return null
	const body = (await res.json()) as CheckRunsResponse
	const runs = body.check_runs ?? []
	const match = runs.find((r) => r.name === FITNESS_CHECK_NAME)
	return match ?? null
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
