/**
 * The wait behind the deep_research tool: poll a run until it ends or the
 * budget of time is spent, whichever comes first. The run keeps going on the
 * server either way; a caller that gets the status back asks again with the id.
 */

export const RESEARCH_WAIT_MS = 90_000
export const RESEARCH_POLL_MS = 3_000

export type ResearchStatus = 'queued' | 'running' | 'done' | 'capped' | 'failed' | 'interrupted'

export interface ResearchRunView {
	id: string
	status: ResearchStatus
	report_md: string | null
	usage?: { cost_cents: number }
	cap?: { cap_cents: number }
	error?: string | null
}

const ENDED: ReadonlySet<ResearchStatus> = new Set(['done', 'capped', 'failed', 'interrupted'])

export function researchRunEnded(run: Pick<ResearchRunView, 'status'>): boolean {
	return ENDED.has(run.status)
}

export async function waitForResearchRun(
	fetchRun: () => Promise<ResearchRunView>,
	opts: {
		waitMs?: number
		pollMs?: number
		sleep?: (ms: number) => Promise<void>
		now?: () => number
	} = {},
): Promise<ResearchRunView> {
	const waitMs = opts.waitMs ?? RESEARCH_WAIT_MS
	const pollMs = opts.pollMs ?? RESEARCH_POLL_MS
	const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
	const now = opts.now ?? Date.now
	const deadline = now() + waitMs

	let run = await fetchRun()
	while (!researchRunEnded(run) && now() + pollMs <= deadline) {
		await sleep(pollMs)
		run = await fetchRun()
	}
	return run
}

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`

/** The text the agent reads for a run in whatever state it is in. */
export function describeResearchRun(run: ResearchRunView): { text: string; isError: boolean } {
	const cost =
		run.usage && run.cap
			? ` Cost ${usd(run.usage.cost_cents)} of a ${usd(run.cap.cap_cents)} cap.`
			: ''
	if (run.status === 'done' || run.status === 'capped') {
		const note =
			run.status === 'capped'
				? 'The run stopped at its cost cap or time limit, so the report is incomplete (it says where).'
				: ''
		return {
			text: [
				run.report_md ?? '(no report text)',
				`research_id: ${run.id}. Status: ${run.status}.${cost} ${note}`.trim(),
			].join('\n\n'),
			isError: false,
		}
	}
	if (run.status === 'failed') {
		return {
			text: `The research run failed: ${run.error ?? 'no reason was recorded'}.${cost} research_id: ${run.id}.`,
			isError: true,
		}
	}
	if (run.status === 'interrupted') {
		return {
			text: `The research run was interrupted before it finished (the server restarted).${cost} Start it again. research_id: ${run.id}.`,
			isError: true,
		}
	}
	return {
		text: `The research is still running (status ${run.status}). It was not finished within the wait, and it keeps going. Call deep_research again with research_id "${run.id}" to wait for the result. Do not start a second run for the same question.`,
		isError: false,
	}
}
