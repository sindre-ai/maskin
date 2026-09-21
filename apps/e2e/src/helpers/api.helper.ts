const BASE_URL = 'http://localhost:5173'

/**
 * The **AGENT_SERVER_SECRET** the E2E stack runs with.
 *
 * Single source of truth: **playwright.config.ts** injects it into the dev
 * webServer's environment, and specs pass it to **postSessionLogs**. One
 * constant means the two cannot drift — a mismatch would 401 the log-ingest
 * call with no obvious cause, and the dev server 503s outright when the
 * variable is unset.
 */
export const E2E_AGENT_SERVER_SECRET = 'e2e-agent-server-secret'

interface CreateActorResponse {
	id: string
	name: string
	type: string
	email: string | null
	api_key: string
}

interface ObjectResponse {
	id: string
	type: string
	title: string
	content: string | null
	status: string
	metadata: Record<string, unknown> | null
	workspaceId: string
	createdBy: string
	createdAt: string
	updatedAt: string
}

interface WorkspaceResponse {
	id: string
	name: string
	settings: Record<string, unknown>
}

interface ActorListItem {
	id: string
	type: string
	name: string
	email: string | null
	role?: string
}

interface EventResponse {
	id: number
	workspaceId: string
	actorId: string
	action: string
	entityType: string
	entityId: string
	data: Record<string, unknown> | null
	createdAt: string | null
}

interface ActorResponse {
	id: string
	type: string
	name: string
	email: string | null
	system_prompt: string | null
	tools: Record<string, unknown> | null
	memory: Record<string, unknown> | null
	llm_provider: string | null
	llm_config: Record<string, unknown> | null
	isSystem: boolean
	createdAt: string | null
	updatedAt: string | null
}

interface FileDetailResponse {
	id: string
	workspaceId: string
	name: string
	description: string | null
	mimeType: string
	sizeBytes: number
	storageKey: string
	createdBy: string
	createdAt: string
	updatedAt: string
	content: string
	encoding: 'base64' | 'utf8'
	url: string
}

interface RelationshipResponse {
	id: string
	sourceType: string
	sourceId: string
	targetType: string
	targetId: string
	type: string
}

interface ConversationParticipantResponse {
	actorId: string
	actorName: string
	actorType: string
	joinedAt: string | null
	addedBy: string | null
}

interface ConversationDetailResponse {
	id: string
	workspaceId: string
	title: string
	createdBy: string
	lastMessageAt: string | null
	createdAt: string | null
	updatedAt: string | null
	pinned: boolean
	archived: boolean
	last_read_message_id: number | null
	participants: ConversationParticipantResponse[]
}

interface MessageResponse {
	id: number
	conversationId: string
	actorId: string
	actorName: string
	actorType: string
	kind: string
	content: string
	metadata: Record<string, unknown> | null
	sessionId: string | null
	createdAt: string | null
}

interface TriggerResponse {
	id: string
	workspaceId: string
	name: string
	type: string
	config: Record<string, unknown> | null
	actionPrompt: string
	targetActorId: string
	enabled: boolean
	createdBy: string
	createdAt: string | null
	updatedAt: string | null
}

interface SessionResponse {
	id: string
	workspaceId: string
	actorId: string
	status: string
	actionPrompt: string
	config: Record<string, unknown> | null
	conversationId: string | null
	createdAt: string | null
	updatedAt: string | null
}

interface SessionLogResponse {
	id: number
	sessionId: string
	stream: string
	content: string
	createdAt: string | null
}

export class TestAPI {
	constructor(
		private apiKey: string,
		private baseURL = BASE_URL,
	) {}

	private headers(workspaceId?: string): Record<string, string> {
		const h: Record<string, string> = {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${this.apiKey}`,
		}
		if (workspaceId) h['X-Workspace-Id'] = workspaceId
		return h
	}

	async listWorkspaces(): Promise<WorkspaceResponse[]> {
		const res = await fetch(`${this.baseURL}/api/workspaces`, {
			headers: this.headers(),
		})
		if (!res.ok) throw new Error(`listWorkspaces failed: ${res.status}`)
		return res.json()
	}

	async createObject(
		workspaceId: string,
		data: {
			type: string
			title: string
			// Required by `createObjectSchema` — omitting it is a 400, so the
			// type mirrors the API rather than letting a spec find out at runtime.
			status: string
			content?: string
			metadata?: Record<string, unknown>
		},
	): Promise<ObjectResponse> {
		const res = await fetch(`${this.baseURL}/api/objects`, {
			method: 'POST',
			headers: this.headers(workspaceId),
			body: JSON.stringify(data),
		})
		if (!res.ok) throw new Error(`createObject failed: ${res.status}`)
		return res.json()
	}

	async listObjects(workspaceId: string): Promise<ObjectResponse[]> {
		const res = await fetch(`${this.baseURL}/api/objects`, {
			headers: this.headers(workspaceId),
		})
		if (!res.ok) throw new Error(`listObjects failed: ${res.status}`)
		return res.json()
	}

	async getObject(id: string, workspaceId: string): Promise<ObjectResponse> {
		const res = await fetch(`${this.baseURL}/api/objects/${id}`, {
			headers: this.headers(workspaceId),
		})
		if (!res.ok) throw new Error(`getObject failed: ${res.status}`)
		return res.json()
	}

	async updateObject(
		id: string,
		workspaceId: string,
		patch: Partial<{
			status: string
			title: string
			content: string
			metadata: Record<string, unknown>
		}>,
	): Promise<ObjectResponse> {
		const res = await fetch(`${this.baseURL}/api/objects/${id}`, {
			method: 'PATCH',
			headers: this.headers(workspaceId),
			body: JSON.stringify(patch),
		})
		if (!res.ok) throw new Error(`updateObject failed: ${res.status}`)
		return res.json()
	}

	async deleteObject(id: string, workspaceId: string): Promise<void> {
		const res = await fetch(`${this.baseURL}/api/objects/${id}`, {
			method: 'DELETE',
			headers: this.headers(workspaceId),
		})
		if (!res.ok) throw new Error(`deleteObject failed: ${res.status}`)
	}

	async createNotification(
		workspaceId: string,
		data: {
			type: string
			title: string
			content?: string
			metadata?: Record<string, unknown>
			source_actor_id: string
			target_actor_id?: string
			object_id?: string
		},
	): Promise<{ id: string; status: string }> {
		const res = await fetch(`${this.baseURL}/api/notifications`, {
			method: 'POST',
			headers: this.headers(workspaceId),
			body: JSON.stringify(data),
		})
		if (!res.ok) throw new Error(`createNotification failed: ${res.status}`)
		return res.json()
	}

	async createComment(
		workspaceId: string,
		data: {
			entity_id: string
			content: string
			parent_event_id?: number
			metadata?: Record<string, unknown>
			mentions?: string[]
			// The structured ask (`commentDecisionSchema`). The API validates it and
			// rejects a block that breaks any of its rules, so a spec that seeds a
			// malformed one fails here rather than rendering nothing later.
			decision?: Record<string, unknown>
		},
	): Promise<EventResponse> {
		const res = await fetch(`${this.baseURL}/api/events`, {
			method: 'POST',
			headers: this.headers(workspaceId),
			body: JSON.stringify(data),
		})
		if (!res.ok) throw new Error(`createComment failed: ${res.status}`)
		return res.json()
	}

	async createWorkspace(name: string): Promise<WorkspaceResponse> {
		const res = await fetch(`${this.baseURL}/api/workspaces`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ name }),
		})
		if (!res.ok) throw new Error(`createWorkspace failed: ${res.status}`)
		return res.json()
	}

	async updateWorkspace(
		id: string,
		data: { name?: string; settings?: Record<string, unknown> },
	): Promise<WorkspaceResponse> {
		const res = await fetch(`${this.baseURL}/api/workspaces/${id}`, {
			method: 'PATCH',
			headers: this.headers(),
			body: JSON.stringify(data),
		})
		if (!res.ok) throw new Error(`updateWorkspace failed: ${res.status}`)
		return res.json()
	}

	async listWorkspaceActors(workspaceId: string): Promise<ActorListItem[]> {
		const res = await fetch(`${this.baseURL}/api/actors`, {
			headers: this.headers(workspaceId),
		})
		if (!res.ok) throw new Error(`listWorkspaceActors failed: ${res.status}`)
		return res.json()
	}

	async getActor(id: string): Promise<ActorResponse> {
		const res = await fetch(`${this.baseURL}/api/actors/${id}`, {
			headers: this.headers(),
		})
		if (!res.ok) throw new Error(`getActor failed: ${res.status}`)
		return res.json()
	}

	async updateActor(
		id: string,
		data: {
			system_prompt?: string | null
			tools?: Record<string, unknown> | null
			llm_provider?: string | null
			llm_config?: Record<string, unknown> | null
		},
	): Promise<ActorResponse> {
		const res = await fetch(`${this.baseURL}/api/actors/${id}`, {
			method: 'PATCH',
			headers: this.headers(),
			body: JSON.stringify(data),
		})
		if (!res.ok) throw new Error(`updateActor failed: ${res.status}`)
		return res.json()
	}

	async deleteActorRaw(
		id: string,
		workspaceId: string,
	): Promise<{ status: number; body: unknown }> {
		const res = await fetch(`${this.baseURL}/api/actors/${id}`, {
			method: 'DELETE',
			headers: this.headers(workspaceId),
		})
		const body = await res.json().catch(() => null)
		return { status: res.status, body }
	}

	async resetActor(id: string, workspaceId: string): Promise<ActorResponse> {
		const res = await fetch(`${this.baseURL}/api/actors/${id}/reset`, {
			method: 'POST',
			headers: this.headers(workspaceId),
		})
		if (!res.ok) throw new Error(`resetActor failed: ${res.status}`)
		return res.json()
	}

	async createFile(
		workspaceId: string,
		data: {
			name: string
			mime_type: string
			content: string
			encoding?: 'base64' | 'utf8'
			description?: string | null
		},
	): Promise<FileDetailResponse> {
		const res = await fetch(`${this.baseURL}/api/files`, {
			method: 'POST',
			headers: this.headers(workspaceId),
			body: JSON.stringify(data),
		})
		if (!res.ok) throw new Error(`createFile failed: ${res.status}`)
		return res.json()
	}

	async createRelationship(
		workspaceId: string,
		data: {
			source_type: string
			source_id: string
			target_type: string
			target_id: string
			type: string
		},
	): Promise<RelationshipResponse> {
		const res = await fetch(`${this.baseURL}/api/relationships`, {
			method: 'POST',
			headers: this.headers(workspaceId),
			body: JSON.stringify(data),
		})
		if (!res.ok) throw new Error(`createRelationship failed: ${res.status}`)
		return res.json()
	}

	async createAgentActor(name: string): Promise<CreateActorResponse> {
		const res = await fetch(`${this.baseURL}/api/actors`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'agent', name }),
		})
		if (!res.ok) throw new Error(`createAgentActor failed: ${res.status}`)
		return res.json()
	}

	async addWorkspaceMember(
		workspaceId: string,
		actorId: string,
		role = 'member',
	): Promise<{ added: boolean }> {
		const res = await fetch(`${this.baseURL}/api/workspaces/${workspaceId}/members`, {
			method: 'POST',
			headers: this.headers(workspaceId),
			body: JSON.stringify({ actor_id: actorId, role }),
		})
		if (!res.ok) throw new Error(`addWorkspaceMember failed: ${res.status}`)
		return res.json()
	}

	async createTrigger(
		workspaceId: string,
		data: {
			name: string
			type: 'cron' | 'event' | 'reminder'
			action_prompt: string
			target_actor_id: string
			config: Record<string, unknown>
			enabled?: boolean
		},
	): Promise<TriggerResponse> {
		const res = await fetch(`${this.baseURL}/api/triggers`, {
			method: 'POST',
			headers: this.headers(workspaceId),
			body: JSON.stringify(data),
		})
		if (!res.ok) throw new Error(`createTrigger failed: ${res.status}`)
		return res.json()
	}

	async listTriggers(workspaceId: string): Promise<TriggerResponse[]> {
		const res = await fetch(`${this.baseURL}/api/triggers`, {
			headers: this.headers(workspaceId),
		})
		if (!res.ok) throw new Error(`listTriggers failed: ${res.status}`)
		return res.json()
	}

	async deleteTrigger(id: string, workspaceId: string): Promise<void> {
		const res = await fetch(`${this.baseURL}/api/triggers/${id}`, {
			method: 'DELETE',
			headers: this.headers(workspaceId),
		})
		if (!res.ok) throw new Error(`deleteTrigger failed: ${res.status}`)
	}

	async createConversation(
		workspaceId: string,
		data: { title: string; participant_actor_ids: string[]; initial_message?: string },
	): Promise<ConversationDetailResponse> {
		const res = await fetch(`${this.baseURL}/api/conversations`, {
			method: 'POST',
			headers: this.headers(workspaceId),
			body: JSON.stringify(data),
		})
		if (!res.ok) throw new Error(`createConversation failed: ${res.status}`)
		return res.json()
	}

	async getConversation(id: string, workspaceId: string): Promise<ConversationDetailResponse> {
		const res = await fetch(`${this.baseURL}/api/conversations/${id}`, {
			headers: this.headers(workspaceId),
		})
		if (!res.ok) throw new Error(`getConversation failed: ${res.status}`)
		return res.json()
	}

	async postConversationMessage(
		id: string,
		workspaceId: string,
		data: { content: string; metadata?: Record<string, unknown> },
	): Promise<MessageResponse> {
		const res = await fetch(`${this.baseURL}/api/conversations/${id}/messages`, {
			method: 'POST',
			headers: this.headers(workspaceId),
			body: JSON.stringify(data),
		})
		if (!res.ok) throw new Error(`postConversationMessage failed: ${res.status}`)
		return res.json()
	}

	async updateConversationMe(
		id: string,
		workspaceId: string,
		data: { pinned?: boolean; archived?: boolean; last_read_message_id?: number },
	): Promise<{ pinned: boolean; archived: boolean; last_read_message_id: number | null }> {
		const res = await fetch(`${this.baseURL}/api/conversations/${id}/me`, {
			method: 'PATCH',
			headers: this.headers(workspaceId),
			body: JSON.stringify(data),
		})
		if (!res.ok) throw new Error(`updateConversationMe failed: ${res.status}`)
		return res.json()
	}

	/**
	 * Create a session row without starting a container (`auto_start: false`,
	 * so it lands in `pending` and never tries to launch).
	 *
	 * The web E2E stack has no container runtime, so a genuinely running
	 * session is impossible here. This seeds the DB row two other things need:
	 * the log-ingest endpoint 410s for an unknown session id, and the SSE
	 * stream authorises the request against the session's workspace. Specs then
	 * present the row to the UI as `running` with a route mock.
	 */
	async createSession(
		workspaceId: string,
		data: {
			actor_id: string
			action_prompt: string
			config?: Record<string, unknown>
			auto_start?: boolean
		},
	): Promise<SessionResponse> {
		const res = await fetch(`${this.baseURL}/api/sessions`, {
			method: 'POST',
			headers: this.headers(workspaceId),
			body: JSON.stringify(data),
		})
		if (!res.ok) throw new Error(`createSession failed: ${res.status}`)
		return res.json()
	}

	/**
	 * POST a batch of log lines to the internal agent-server ingest endpoint.
	 *
	 * This is the path a remote agent-server uses in production, and the one
	 * that emits on the in-process `log` bus the SSE stream reads. Using it —
	 * rather than seeding `session_logs` directly — is what makes the
	 * live-update spec exercise the real stream end to end.
	 *
	 * Needs the **AGENT_SERVER_SECRET** bearer, which the dev server reads from
	 * its own environment (the route 503s when unset).
	 */
	async postSessionLogs(
		sessionId: string,
		logs: { stream: 'stdout' | 'stderr' | 'system'; content: string }[],
		secret: string,
	): Promise<{ accepted: number }> {
		const res = await fetch(
			`${this.baseURL}/api/internal/agent-servers/sessions/${sessionId}/logs`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
				body: JSON.stringify({ logs }),
			},
		)
		if (!res.ok) throw new Error(`postSessionLogs failed: ${res.status}`)
		return res.json()
	}

	/**
	 * Read a session's persisted log history — the canonical transcript.
	 *
	 * The endpoint always returns rows in ascending id order regardless of
	 * **order** / **before**, so this is the authoritative sequence to diff a
	 * client-side transcript against: any duplicate or gap in the UI shows up
	 * as a mismatch here.
	 */
	async getSessionLogs(
		sessionId: string,
		workspaceId: string,
		params: { since?: string; before?: string; limit?: string; order?: 'asc' | 'desc' } = {},
	): Promise<SessionLogResponse[]> {
		const query = new URLSearchParams(params)
		const res = await fetch(`${this.baseURL}/api/sessions/${sessionId}/logs?${query}`, {
			headers: this.headers(workspaceId),
		})
		if (!res.ok) throw new Error(`getSessionLogs failed: ${res.status}`)
		return res.json()
	}
}

export async function createTestActor(
	data: { name: string; email?: string; password?: string } = { name: `E2E Test ${Date.now()}` },
): Promise<CreateActorResponse> {
	const email = data.email ?? `e2e-${Date.now()}@test.invalid`
	const password = data.password ?? 'e2e-test-password-123'
	const res = await fetch(`${BASE_URL}/api/actors`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ type: 'human', ...data, email, password }),
	})
	if (!res.ok) throw new Error(`createTestActor failed: ${res.status}`)
	return res.json()
}
