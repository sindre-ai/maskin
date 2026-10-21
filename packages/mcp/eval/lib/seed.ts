import type { Seeder } from './types'

export interface StagingConfig {
	apiUrl: string
	workspaceId: string
	apiKey: string
}

const PRODUCTION_HOSTS = /maskin\.io|sindre\.ai/

// The API wants a status on every object. These are the first status of each
// type in a fresh workspace (see get_workspace_schema).
const ENTRY_STATUS: Record<string, string> = {
	bet: 'signal',
	task: 'backlog',
	insight: 'new',
	knowledge: 'draft',
}

/** The harness only ever talks to a throwaway stack. Refuse anything that looks like production. */
export function assertNotProduction(apiUrl: string): void {
	if (PRODUCTION_HOSTS.test(apiUrl)) {
		throw new Error(`Refusing to run: ${apiUrl} looks like production`)
	}
}

export function createRestSeeder(config: StagingConfig): Seeder {
	assertNotProduction(config.apiUrl)

	async function call(method: string, path: string, body?: unknown): Promise<unknown> {
		const response = await fetch(`${config.apiUrl}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				'X-Workspace-Id': config.workspaceId,
				'Content-Type': 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		const text = await response.text()
		if (!response.ok) {
			throw new Error(`${method} ${path} failed with ${response.status}: ${text.slice(0, 300)}`)
		}
		return text ? JSON.parse(text) : null
	}

	return {
		async createObject(input) {
			const status = input.status ?? ENTRY_STATUS[input.type]
			const created = (await call('POST', '/api/objects', { ...input, status })) as {
				id: string
			}
			return { id: created.id }
		},
		async createEdge({ sourceId, targetId, type }) {
			await call('POST', '/api/relationships', {
				source_type: 'object',
				source_id: sourceId,
				target_type: 'object',
				target_id: targetId,
				type,
			})
		},
		async ensureHelperAgent(name) {
			const actors = (await call('GET', '/api/actors')) as { id: string; name: string }[]
			const existing = actors.find((actor) => actor.name === name)
			if (existing) return { id: existing.id }
			const created = (await call('POST', '/api/actors', {
				type: 'agent',
				name,
				description: 'Helper agent for the MCP eval harness tasks. Never started.',
				workspace_id: config.workspaceId,
			})) as { id: string }
			return { id: created.id }
		},
		async putSkill(name, content) {
			const path = `/api/workspaces/${config.workspaceId}/skills`
			try {
				await call('PUT', `${path}/${encodeURIComponent(name)}`, { content })
			} catch (err) {
				if (!String(err).includes('404')) throw err
				await call('POST', path, { name, content })
			}
		},
	}
}
