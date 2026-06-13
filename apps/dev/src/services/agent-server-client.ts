// The shape of a row from the `agent_servers` table (T5). Kept inline so this
// client doesn't depend on the schema export landing on `bet/session-infra-scale`
// in any particular order — any caller can satisfy it with a Drizzle row, a
// seed fixture, or a hand-built object in a test.
export type AgentServerRow = {
	id: string
	url: string
	secret: string
}

export class AgentServerAuthError extends Error {
	readonly kind = 'unauthorized' as const
	constructor(readonly server: { id: string; url: string }) {
		super(`agent-server ${server.url} rejected bearer token`)
		this.name = 'AgentServerAuthError'
	}
}

export class AgentServerHttpError extends Error {
	constructor(
		readonly server: { id: string; url: string },
		readonly status: number,
		readonly body: string,
	) {
		super(`agent-server ${server.url} returned ${status}: ${body.slice(0, 200)}`)
		this.name = 'AgentServerHttpError'
	}
}

export type StartSessionRequest = {
	sessionId: string
	image: string
	env?: Record<string, string>
	memoryMib?: number
	cpus?: number
}

export type StartSessionResponse = {
	sessionId: string
	sandboxName: string
	connection: { host: string; port: number }
	env_overflow_spilled?: number
	env_sanitized?: number
}

export type AgentServerClientDeps = {
	server: AgentServerRow
	fetchImpl?: typeof fetch
}

// Single dispatch surface for apps/dev → apps/agent-server. Always sets the
// shared bearer token and Content-Type so no caller can dispatch without auth.
// Surfaces 401 as a typed error so the dispatcher (T6) can distinguish a
// rotation race from a generic HTTP failure.
export class AgentServerClient {
	private readonly fetchImpl: typeof fetch

	constructor(private readonly deps: AgentServerClientDeps) {
		this.fetchImpl = deps.fetchImpl ?? fetch
	}

	startSession(req: StartSessionRequest): Promise<StartSessionResponse> {
		return this.postJson<StartSessionResponse>('/sessions', req)
	}

	// Public to let lifecycle-route callers (T3 stop/snapshot/restore) reuse the
	// bearer + content-type plumbing without re-implementing it.
	async postJson<T>(path: string, body: unknown): Promise<T> {
		const url = joinUrl(this.deps.server.url, path)
		const res = await this.fetchImpl(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this.deps.server.secret}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		})
		if (res.status === 401) {
			throw new AgentServerAuthError({ id: this.deps.server.id, url: this.deps.server.url })
		}
		if (!res.ok) {
			const text = await res.text().catch(() => '<unreadable body>')
			throw new AgentServerHttpError(
				{ id: this.deps.server.id, url: this.deps.server.url },
				res.status,
				text,
			)
		}
		return (await res.json()) as T
	}
}

function joinUrl(base: string, path: string): string {
	const trimmedBase = base.replace(/\/+$/, '')
	const trimmedPath = path.startsWith('/') ? path : `/${path}`
	return `${trimmedBase}${trimmedPath}`
}
