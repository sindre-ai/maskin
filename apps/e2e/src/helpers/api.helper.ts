const BASE_URL = 'http://localhost:5173'

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
			status?: string
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

	async deleteObject(id: string, workspaceId: string): Promise<void> {
		const res = await fetch(`${this.baseURL}/api/objects/${id}`, {
			method: 'DELETE',
			headers: this.headers(workspaceId),
		})
		if (!res.ok) throw new Error(`deleteObject failed: ${res.status}`)
	}

	async createComment(
		workspaceId: string,
		data: { entity_id: string; content: string; parent_event_id?: number },
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
