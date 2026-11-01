import { type ResearchRunInput, type ResearchRunOutcome, runResearch } from './run'

/**
 * A simple-effort run: one researcher, no lead call (spec 7.2). The run itself
 * lives in run.ts; this keeps the simple-effort entry point and its names.
 */
export { RUN_DEADLINE_MS, SIMPLE_MAX_TOOL_CALLS } from './run'

export type SimpleRunInput = Omit<ResearchRunInput, 'effort'>
export type SimpleRunOutcome = ResearchRunOutcome
export type SimpleRunStatus = ResearchRunOutcome['status']

export function runSimpleResearch(input: SimpleRunInput): Promise<SimpleRunOutcome> {
	return runResearch({ ...input, effort: 'simple' })
}
