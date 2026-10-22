import type { McpMisfireKind } from '../../src/telemetry'

// The error kinds are the ones the server already writes into mcp_telemetry
// (see classifyMcpError in apps/dev/src/routes/mcp.ts). The harness reads them
// back as they are: no second taxonomy.
export const MISFIRE_KINDS = [
	'tool_not_found',
	'unknown_param',
	'schema_validation_error',
] as const satisfies readonly McpMisfireKind[]

export type MisfireKind = (typeof MISFIRE_KINDS)[number]

export type RunnerName = 'agent-sdk' | 'create-session'

export interface ObjectRow {
	id: string
	type: string
	title: string | null
	status: string
	content: string | null
	driver: string | null
}

export interface EdgeRow {
	sourceId: string
	targetId: string
	type: string
}

export interface SessionRow {
	id: string
	actorId: string
	initiatedFromObjectId: string | null
	actionPrompt: string
}

/** Read-only view of staging state. Everything a checker may look at. */
export interface StagingState {
	objectsByTitle(title: string): Promise<ObjectRow[]>
	edgesInvolving(objectId: string): Promise<EdgeRow[]>
	skillContent(name: string): Promise<string | null>
	sessionsInitiatedFrom(objectId: string): Promise<SessionRow[]>
}

/** Writes used to set a task up. Never used by checkers. */
export interface Seeder {
	createObject(input: {
		type: string
		title: string
		content?: string
		status?: string
	}): Promise<{ id: string }>
	createEdge(input: { sourceId: string; targetId: string; type: string }): Promise<void>
	ensureHelperAgent(name: string): Promise<{ id: string }>
	putSkill(name: string, content: string): Promise<void>
}

export interface TelemetrySummary {
	/** Rows with event_type tool_call for the session. */
	callCount: number
	errorsTotal: number
	errorsByKind: Record<MisfireKind, number>
	/** Error rows per tool name, any kind. */
	errorRowsByTool: Record<string, number>
}

export interface TaskContext {
	/** Fresh uuid per run. Sent as X-Maskin-Session-Id, so telemetry rows join to it. */
	sessionId: string
	/** First 8 characters of sessionId, used to make titles unique per run. */
	short: string
	workspaceId: string
	state: StagingState
	seeder: Seeder
}

export type Seed = Record<string, string>

export interface CheckResult {
	passed: boolean
	reason: string
}

export interface TaskDef {
	id: string
	title: string
	heldOut: boolean
	/** The drifted parameter this task exercises, in words. */
	drift: string
	setup(ctx: TaskContext): Promise<Seed>
	/** Never names an argument: the agent has to find the spelling itself. */
	prompt(ctx: TaskContext, seed: Seed): string
	check(ctx: TaskContext, seed: Seed, telemetry: TelemetrySummary): Promise<CheckResult>
}

export interface TokenUsage {
	input: number
	output: number
	cacheRead: number
	cacheCreation: number
	total: number
}

/** What a runner reports for one agent run. */
export interface RunOutcome {
	runner: RunnerName
	model: string | null
	costUsd: number | null
	tokens: TokenUsage | null
	numTurns: number | null
	/** tool_use blocks the agent sent, counting attempts that failed validation. */
	clientToolUses: number
	/** tool_result blocks the client saw flagged as errors. */
	clientToolErrors: number
	finished: boolean
	error: string | null
	durationMs: number
}

export interface ResultRow {
	task_id: string
	held_out: boolean
	run_index: number
	session_id: string
	workspace_id: string
	passed: boolean
	check_reason: string
	call_count: number
	tokens: TokenUsage | null
	tokens_source: string
	cost_usd: number | null
	errors_total: number
	errors_by_kind: Record<MisfireKind, number>
	error_rows_by_tool: Record<string, number>
	client_tool_uses: number
	client_tool_errors: number
	num_turns: number | null
	duration_ms: number
	run_date: string
	runner: RunnerName
	model: string | null
	run_error: string | null
}
