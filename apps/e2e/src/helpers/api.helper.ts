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
		data: { type: string; title: string; status?: string; content?: string },
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
}

export async function createTestActor(
	data: { name: string; email?: string } = { name: `E2E Test ${Date.now()}` },
): Promise<CreateActorResponse> {
	const res = await fetch(`${BASE_URL}/api/actors`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ type: 'human', ...data }),
	})
	if (!res.ok) throw new Error(`createTestActor failed: ${res.status}`)
	return res.json()
}
