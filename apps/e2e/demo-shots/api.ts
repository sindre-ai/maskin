import { API_URL, DEMO_WORKSPACE_ID, assertDemoWorkspace, requireEnv } from './config'

export interface ApiObject {
	id: string
	type: string
	title: string
	status: string
	content: string | null
	metadata: Record<string, unknown> | null
	createdAt: string
}

export interface ApiActor {
	id: string
	type: string
	name: string
	email: string | null
}

export interface LoggedInActor extends ApiActor {
	api_key: string
}

/**
 * Signs in with the demo account's email and password from the environment and returns the
 * actor with a fresh API key. The web app signs in the same way: it keeps this key in
 * localStorage. The password is only ever sent to the login endpoint, never logged.
 */
export async function login(): Promise<LoggedInActor> {
	const res = await fetch(`${API_URL}/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			email: requireEnv('DEMO_EMAIL'),
			password: requireEnv('DEMO_PASSWORD'),
		}),
	})
	if (!res.ok) throw new Error(`Demo login failed: ${res.status}`)
	return res.json()
}

/** A client for the demo workspace. The workspace id is fixed and checked on construction. */
export class DemoApi {
	constructor(
		private apiKey: string,
		workspaceId: string = DEMO_WORKSPACE_ID,
	) {
		assertDemoWorkspace(workspaceId)
	}

	async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await fetch(`${API_URL}${path}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
				'X-Workspace-Id': DEMO_WORKSPACE_ID,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		if (!res.ok) {
			// The response text names the rule that failed; it never contains our credentials.
			throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`)
		}
		return res.json() as Promise<T>
	}

	/** The demo workspace must be visible to the account, and be the workspace we expect. */
	async assertMember(expectedName: string): Promise<void> {
		const workspaces = await this.request<{ id: string; name: string }[]>('GET', '/workspaces')
		const demo = workspaces.find((w) => w.id === DEMO_WORKSPACE_ID)
		if (!demo) {
			throw new Error(
				'The demo account is not a member of the demo workspace. A person has to add it (Settings, Members).',
			)
		}
		if (demo.name !== expectedName) {
			throw new Error(
				`Workspace ${DEMO_WORKSPACE_ID} is named "${demo.name}", expected "${expectedName}"`,
			)
		}
	}

	async listObjects(type: string): Promise<ApiObject[]> {
		return this.request('GET', `/objects?type=${type}&limit=100`)
	}

	async listActors(): Promise<ApiActor[]> {
		return this.request('GET', '/actors')
	}
}
