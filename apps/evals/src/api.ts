/**
 * Thin typed wrapper over the Maskin HTTP API.
 *
 * Used for two things only: standing up a fixture workspace before an attempt,
 * and reading the workspace back afterwards to grade what the model actually
 * built. It is deliberately not used to *perform* the work under test - the
 * model reaches the same server through MCP (see executor.ts), which is the
 * surface being graded.
 */

export const DEFAULT_BASE_URL = 'http://localhost:3000'

export function apiBaseUrl(): string {
	// `||` for the same reason as run.ts's model default: an env var set to
	// the empty string is set, and `??` would return it.
	return process.env.MASKIN_API_URL || DEFAULT_BASE_URL
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly method: string,
		readonly path: string,
		body: string,
	) {
		super(`${method} ${path} -> ${status}: ${body.slice(0, 400)}`)
		this.name = 'ApiError'
	}
}

interface RequestOptions {
	method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
	body?: unknown
	apiKey?: string
	workspaceId?: string
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
	const { method = 'GET', body, apiKey, workspaceId } = opts
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`
	if (workspaceId) headers['X-Workspace-Id'] = workspaceId

	const res = await fetch(`${apiBaseUrl()}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	if (!res.ok) throw new ApiError(res.status, method, path, await res.text())
	return (await res.json()) as T
}

export interface CreatedActor {
	id: string
	api_key: string
}

/**
 * Sign up a bare actor with no workspace.
 *
 * `auto_create_workspace: false` is load-bearing. The default for a human runs
 * provisionWorkspace(), which seeds the full default agent roster, default
 * loops, and a Chief of Staff kickoff *container session* - none of which we
 * want inside an eval, and the default loops alone would break the "exactly one
 * loop exists" assertion before the model had done anything.
 */
export async function createEvalActor(name: string, email: string): Promise<CreatedActor> {
	return request<CreatedActor>('/api/actors', {
		method: 'POST',
		body: {
			type: 'human',
			name,
			email,
			password: 'eval-harness-password',
			auto_create_workspace: false,
		},
	})
}

export interface ActorListItem {
	id: string
	type: string
	name: string
}

export async function listActors(apiKey: string, workspaceId: string): Promise<ActorListItem[]> {
	return request<ActorListItem[]>('/api/actors', { apiKey, workspaceId })
}

/** The fields of a loop row this harness grades on. See loopSummarySchema. */
export interface LoopSummary {
	id: string
	name: string
	status: string
	/** Distinct agent actors reachable through the loop's triggers. */
	agentIds: string[]
	/** Trigger ids referenced in the loop row's `metadata.trigger_ids`. */
	triggerIds: string[]
}

export async function listLoops(apiKey: string, workspaceId: string): Promise<LoopSummary[]> {
	const res = await request<{ loops: LoopSummary[] }>('/api/loops', { apiKey, workspaceId })
	return res.loops
}

/** Poll /api/health until the server answers, so a run fails fast and clearly. */
export async function waitForApi(timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	let lastError = 'no attempt made'
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${apiBaseUrl()}/api/health`)
			if (res.ok) return
			lastError = `status ${res.status}`
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err)
		}
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	throw new Error(
		`No Maskin API at ${apiBaseUrl()} after ${timeoutMs}ms (${lastError}). Start the stack with \`pnpm dev\` (or \`pnpm dev:no-docker\`), or set MASKIN_API_URL.`,
	)
}
