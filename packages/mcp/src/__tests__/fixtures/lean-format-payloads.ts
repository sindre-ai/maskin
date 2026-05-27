/**
 * Representative API payloads used by the lean-format contract tests.
 *
 * These fixtures pin the *shape* of what each MCP tool's API call returns,
 * so the format-contract tests can exercise every read-style handler with a
 * realistic body and assert the same four properties uniformly:
 *
 *   (a) `content` length is bounded — the lean markdown is markedly shorter
 *       than the raw JSON it summarises (Direction 1's ≥60% token-reduction
 *       target).
 *   (b) `content` carries exactly one HTTPS deep link per object (plus the
 *       optional header link for list-shaped tools).
 *   (c) `structuredContent` is set and preserves the prior JSON shape.
 *   (d) `content` has no tool-result pagination noise ("page N of M", etc.).
 *
 * Keep these as plain literals — no factory helpers — so the snapshots in
 * `server.test.ts` read top-to-bottom against the fixture they exercise.
 */

export const WS_ID = '00000000-0000-4000-8000-000000000001'
export const WEB_APP_BASE_URL = 'https://maskin.app'

/** Deterministic UUIDs so snapshots stay byte-stable across CI runs. */
export const OBJECT_ID_1 = '00000000-0000-4000-8000-aaaaaaaaaaa1'
export const OBJECT_ID_2 = '00000000-0000-4000-8000-aaaaaaaaaaa2'
export const OBJECT_ID_3 = '00000000-0000-4000-8000-aaaaaaaaaaa3'
export const ACTOR_ID_1 = '00000000-0000-4000-8000-bbbbbbbbbbb1'
export const ACTOR_ID_2 = '00000000-0000-4000-8000-bbbbbbbbbbb2'
export const FILE_ID_1 = '00000000-0000-4000-8000-cccccccccccc'
export const TRIGGER_ID_1 = '00000000-0000-4000-8000-dddddddddddd'
export const SESSION_ID_1 = '00000000-0000-4000-8000-eeeeeeeeeeee'

export const LIST_OBJECTS_PAYLOAD = [
	{
		id: OBJECT_ID_1,
		type: 'bet',
		title: 'Ship MCP lean results',
		status: 'active',
		content: 'Redesign Maskin MCP tool results for a simple, elegant Claude experience.',
	},
	{
		id: OBJECT_ID_2,
		type: 'task',
		title: 'Task 5 — Update MCP tests for new result format',
		status: 'in_progress',
		content: 'Replace assertions on the old prose format with format-contract guards.',
	},
	{
		id: OBJECT_ID_3,
		type: 'task',
		title: 'Task 4 — Wire formatter into all MCP read tools',
		status: 'done',
		content: 'Done.',
	},
]

export const GET_OBJECTS_PAYLOAD = {
	object: {
		id: OBJECT_ID_1,
		type: 'bet',
		title: 'Ship MCP lean results',
		status: 'active',
		content:
			'Redesign Maskin MCP tool results for a simple, elegant Claude experience. ' +
			'Engages anchors #3 (execution) and #6 (coherence).',
	},
	relationships: [],
	connected_objects: [],
	events: [
		{
			id: 42,
			action: 'status_changed',
			createdAt: '2026-05-25T09:30:14.641Z',
			description: 'changed status from Proposed to Active',
		},
	],
	files: [],
}

export const SEARCH_OBJECTS_PAYLOAD = [
	{ id: OBJECT_ID_1, type: 'bet', title: 'Ship MCP lean results', status: 'active', content: '' },
	{ id: OBJECT_ID_2, type: 'task', title: 'Task 5 — tests', status: 'in_progress', content: '' },
]

export const LIST_UNREAD_PAYLOAD = [
	{
		entity_type: 'object',
		entity_id: OBJECT_ID_1,
		unread_count: 3,
		latest_activity_at: '2026-05-25T09:00:00.000Z',
		object: { id: OBJECT_ID_1, type: 'bet', title: 'Ship MCP lean results' },
	},
	{
		entity_type: 'object',
		entity_id: OBJECT_ID_2,
		unread_count: 1,
		latest_activity_at: '2026-05-26T11:00:00.000Z',
		object: { id: OBJECT_ID_2, type: 'task', title: 'Task 5' },
	},
]

export const LIST_ACTORS_PAYLOAD = [
	{ id: ACTOR_ID_1, type: 'agent' as const, name: 'Senior Developer', email: null },
	{ id: ACTOR_ID_2, type: 'human' as const, name: 'Operator', email: 'op@example.com' },
]

export const LIST_FILES_PAYLOAD = [
	{ id: FILE_ID_1, name: 'design-doc.md', mimeType: 'text/markdown', sizeBytes: 4321 },
]

export const LIST_TRIGGERS_PAYLOAD = [
	{ id: TRIGGER_ID_1, name: 'Weekly digest', type: 'cron', enabled: true },
]

export const LIST_SESSIONS_PAYLOAD = [{ id: SESSION_ID_1, actorId: ACTOR_ID_1, status: 'running' }]

export const LIST_RELATIONSHIPS_PAYLOAD = [
	{
		id: '00000000-0000-4000-8000-fffffffffff1',
		sourceTitle: 'Ship MCP lean results',
		targetTitle: 'Task 5',
		type: 'breaks_into',
		sourceId: OBJECT_ID_1,
		targetId: OBJECT_ID_2,
	},
]

export const GET_WORKSPACE_SCHEMA_PAYLOAD = {
	workspaces: [{ id: WS_ID, name: 'Test Workspace', settings: {} }],
	// The handler builds a schema view; just need workspaces fetch + the
	// handler computes the schema from settings + module defaults.
}

export const LIST_WORKSPACE_SKILLS_PAYLOAD = [
	{ name: 'spec-brief', description: 'Enforces the minimum brief contract' },
	{ name: 'ship', description: 'Pre-handoff self-review' },
]

export const LIST_INTEGRATIONS_PAYLOAD = [
	{
		id: '00000000-0000-4000-8000-ffffffffaaa1',
		provider: 'slack',
		name: 'Slack',
		status: 'connected',
	},
]

export const LIST_EXTENSIONS_PAYLOAD_WORKSPACES = [
	{ id: WS_ID, name: 'Test', settings: { enabled_modules: ['work'] } },
]

export const LIST_SUBSCRIBERS_PAYLOAD = [
	{ actorId: ACTOR_ID_1, name: 'Senior Developer', email: null },
	{ actorId: ACTOR_ID_2, name: 'Operator', email: 'op@example.com' },
]

export const GET_COMMENTS_PAYLOAD = [
	{
		id: 1,
		actorId: ACTOR_ID_1,
		data: { content: 'Looks good — shipping after CI.' },
		createdAt: '2026-05-26T12:00:00.000Z',
	},
]

export const GET_EVENTS_PAYLOAD = [
	{
		id: 1,
		action: 'updated',
		entityType: 'task',
		entityId: OBJECT_ID_2,
		description: 'Task 5 moved to in_progress',
		createdAt: '2026-05-26T12:00:00.000Z',
	},
]

export const GET_ACTOR_PAYLOAD = {
	id: ACTOR_ID_1,
	name: 'Senior Developer',
	type: 'agent' as const,
	email: null,
}

export const GET_FILE_PAYLOAD = {
	id: FILE_ID_1,
	name: 'design-doc.md',
	mimeType: 'text/markdown',
	sizeBytes: 4321,
}

export const GET_WORKSPACE_SKILL_PAYLOAD = {
	name: 'spec-brief',
	description: 'Enforces the minimum brief contract',
	content: '# Spec brief…',
}

export const LIST_WORKSPACES_PAYLOAD = [{ id: WS_ID, name: 'Test Workspace', settings: {} }]

export const LIST_INTEGRATION_PROVIDERS_PAYLOAD = [
	{ id: 'slack', name: 'slack', displayName: 'Slack' },
	{ id: 'github', name: 'github', displayName: 'GitHub' },
]

export const GET_LLM_API_KEYS_WORKSPACE_PAYLOAD = {
	id: WS_ID,
	name: 'Test Workspace',
	settings: { llm_keys: { anthropic: 'sk-ant-xxxxxxxxxxxxxxxxxxxxxxx' } },
}

export const GET_CLAUDE_SUBSCRIPTION_STATUS_PAYLOAD = {
	connected: true,
	valid: true,
}
