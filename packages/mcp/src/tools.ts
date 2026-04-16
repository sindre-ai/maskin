import { z } from 'zod'

const optionalWorkspaceId = z
	.string()
	.uuid()
	.optional()
	.describe(
		'Workspace ID to operate in. If omitted, uses the default workspace (DEFAULT_WORKSPACE_ID). Call list_workspaces to discover available workspaces.',
	)

export const tools = {
	// ─── Welcome ─────────────────────────────────────────────
	hello: {
		description:
			'👋 Welcome! Start here. Get a friendly overview of what Maskin is, what you can do, and how this workspace is set up — including object types, statuses, custom fields, team members, and available tools. Think of it as your agent landing page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
		}),
	},

	// ─── Objects ─────────────────────────────────────────────
	create_objects: {
		description:
			'Create one or more objects (insights, bets, tasks) with optional relationships in a single atomic operation. For a single object, provide one node with no edges. For multiple related objects, use $id references in edges to link them. Edges can also reference existing object UUIDs to connect new objects to existing ones. Call get_workspace_schema first to discover valid statuses, metadata fields, and relationship types. Status defaults — insight: new|processing|clustered|discarded, bet: signal|proposed|active|completed|succeeded|failed|paused, task: todo|in_progress|done|blocked.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			nodes: z
				.array(
					z.object({
						$id: z.string().describe('Client-side temporary ID for cross-referencing in edges'),
						type: z.string().describe('Object type (e.g. insight, bet, task, meeting)'),
						title: z.string().optional(),
						content: z.string().optional(),
						status: z.string(),
						metadata: z
							.record(z.unknown())
							.optional()
							.describe(
								'Key-value metadata. Call get_workspace_schema to discover available fields and types.',
							),
					}),
				)
				.min(1)
				.max(50)
				.describe('Objects to create'),
			edges: z
				.array(
					z.object({
						source: z
							.string()
							.describe('A $id from a node in this request, or a UUID of an existing object'),
						target: z
							.string()
							.describe('A $id from a node in this request, or a UUID of an existing object'),
						type: z
							.string()
							.describe('Relationship type: informs, breaks_into, blocks, relates_to, duplicates'),
					}),
				)
				.default([])
				.describe('Relationships to create between new and/or existing objects'),
		}),
	},
	get_objects: {
		description:
			'Get one or more objects by ID, each with all its relationships and connected objects. Returns the full context around each object including inbound/outbound relationships and details of connected objects.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			ids: z.array(z.string().uuid()).min(1).max(50).describe('Object IDs to fetch'),
		}),
	},
	update_objects: {
		description:
			'Update one or more objects and/or create relationships between existing objects. Provide updates to change object fields (title, content, status, metadata) and/or edges to create new relationships. Either updates or edges (or both) must be provided. Call get_workspace_schema first to discover valid metadata fields and relationship types.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			updates: z
				.array(
					z.object({
						id: z.string().uuid(),
						title: z.string().optional(),
						content: z.string().optional(),
						status: z.string().optional(),
						metadata: z
							.record(z.unknown())
							.optional()
							.describe(
								'Key-value metadata. Call get_workspace_schema to discover available fields and types.',
							),
					}),
				)
				.default([])
				.describe('Objects to update, each with id and fields to change'),
			edges: z
				.array(
					z.object({
						source_id: z.string().uuid().describe('Source object UUID'),
						target_id: z.string().uuid().describe('Target object UUID'),
						type: z
							.string()
							.describe('Relationship type: informs, breaks_into, blocks, relates_to, duplicates'),
					}),
				)
				.default([])
				.describe('Relationships to create between existing objects'),
		}),
	},
	delete_object: {
		description:
			'Delete an object by ID. Also removes all relationships connected to this object. This action is irreversible.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	list_objects: {
		description:
			'List objects in the workspace, ordered by creation date (newest first). Filter by type (e.g. insight, bet, task) and/or status. Default limit: 50, max: 100. Use search_objects for keyword matching instead.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z.string().describe('Object type (e.g. insight, bet, task, meeting)').optional(),
			status: z.string().optional(),
			limit: z.number().int().min(1).max(100).default(50),
			offset: z.number().int().min(0).default(0),
		}),
	},
	search_objects: {
		description:
			'Search objects by text in title or content (case-insensitive substring match), combined with optional type/status filters. Default limit: 20. Use this instead of list_objects when you need to find objects by keyword.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			q: z
				.string()
				.min(1)
				.describe('Search query — matches against title and content (case-insensitive)'),
			type: z.string().describe('Object type (e.g. insight, bet, task, meeting)').optional(),
			status: z.string().optional(),
			limit: z.number().int().min(1).max(100).default(20),
			offset: z.number().int().min(0).default(0),
		}),
	},
	list_relationships: {
		description:
			'List relationships with optional filters. Filter by source_id, target_id, or type. Valid types: informs, breaks_into, blocks, relates_to, duplicates (plus any custom types from extensions). Relationships are directional — use source_id for outbound, target_id for inbound.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			source_id: z.string().uuid().optional(),
			target_id: z.string().uuid().optional(),
			type: z.string().optional(),
		}),
	},
	delete_relationship: {
		description:
			'Delete a relationship by ID. The connected objects are preserved. Use list_relationships to find IDs.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	create_actor: {
		description:
			'Create a new actor (human or agent) and optionally add them to a workspace. Returns the actor details and API key (only shown once). If workspace_id is provided, the actor is added as a member with the given role. If auto_create_workspace is true (default for humans), a new workspace is created instead.',
		inputSchema: z.object({
			type: z.enum(['human', 'agent']),
			name: z.string().min(1),
			email: z.string().email().optional(),
			auto_create_workspace: z.boolean().optional(),
			workspace_id: z
				.string()
				.uuid()
				.optional()
				.describe('Add the new actor to this existing workspace'),
			role: z
				.enum(['owner', 'member', 'viewer'])
				.default('member')
				.describe(
					'Role when adding to a workspace: owner (full control), member (read/write), viewer (read-only)',
				),
			system_prompt: z.string().optional(),
			tools: z.record(z.unknown()).optional(),
			llm_provider: z.string().optional(),
			llm_config: z.record(z.unknown()).optional(),
		}),
	},
	update_actor: {
		description:
			'Update an actor by ID. Can change name, email, system_prompt (for agents), tools configuration, memory (persistent key-value store), LLM provider, and LLM config.',
		inputSchema: z.object({
			id: z.string().uuid(),
			name: z.string().min(1).optional(),
			email: z.string().email().optional(),
			system_prompt: z.string().optional(),
			tools: z.record(z.unknown()).optional(),
			memory: z.record(z.unknown()).optional(),
			llm_provider: z.string().optional(),
			llm_config: z.record(z.unknown()).optional(),
		}),
	},
	regenerate_api_key: {
		description:
			'Regenerate the API key for an actor. The old key is immediately invalidated. Returns the new key (only shown once).',
		inputSchema: z.object({
			id: z.string().uuid(),
		}),
	},
	list_actors: {
		description:
			'List all actors (humans and agents) in the workspace, including their roles (owner, member, viewer).',
		inputSchema: z.object({}),
	},
	get_actor: {
		description:
			'Get actor details by ID, including type, role, and email. For agents: system_prompt, tools, and LLM config. Use list_actors to find actor IDs.',
		inputSchema: z.object({
			id: z.string().uuid(),
		}),
	},
	create_workspace: {
		description: 'Create a new workspace. The authenticated actor becomes the owner.',
		inputSchema: z.object({
			name: z.string().min(1),
			settings: z.record(z.unknown()).optional(),
		}),
	},
	update_workspace: {
		description: 'Update a workspace by ID (name and/or settings)',
		inputSchema: z.object({
			id: z.string().uuid(),
			name: z.string().min(1).optional(),
			settings: z.record(z.unknown()).optional(),
		}),
	},
	list_workspaces: {
		description:
			'List workspaces accessible to the authenticated actor. Use this to discover workspace IDs, which can be passed to any workspace-scoped tool via the workspace_id parameter.',
		inputSchema: z.object({}),
	},
	get_workspace_schema: {
		description:
			'Get the workspace schema: available statuses per object type, custom metadata field definitions (name, type, required, enum values), display names, and relationship types. Call this before creating or updating objects to know which metadata fields exist, what types they expect, and which values are valid. Optionally filter by object type.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z
				.string()
				.optional()
				.describe(
					'Filter schema to a specific object type (e.g. insight, bet, task, meeting). If omitted, returns schema for all types.',
				),
		}),
	},
	add_workspace_member: {
		description:
			'Add an existing actor to a workspace. Use this to grant an agent or human access to a workspace. Requires the actor ID and workspace ID.',
		inputSchema: z.object({
			workspace_id: z.string().uuid().describe('The workspace to add the member to'),
			actor_id: z.string().uuid().describe('The actor to add as a member'),
			role: z
				.enum(['owner', 'admin', 'member'])
				.default('member')
				.describe('Role: owner (full control), admin (manage members), member (read/write)'),
		}),
	},
	get_events: {
		description:
			'Get the workspace activity log (newest first). Every mutation is recorded as an event. Filter by entity_type (object, relationship, integration, trigger, session, notification) and action (created, updated, deleted, status_changed). Use this to track agent activity or audit changes.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			entity_type: z.string().optional(),
			action: z.string().optional(),
			limit: z.number().int().min(1).max(100).default(50),
		}),
	},
	create_trigger: {
		description:
			"Create an automation trigger that fires an agent on a schedule or event. Cron triggers use standard 5-field expressions (config: { expression: '*/5 * * * *' }). Event triggers fire on mutations (config: { entity_type: 'object', action: 'created'|'updated'|'deleted'|'status_changed', filter: { type: 'task' } }). The target_actor_id must be an agent — use list_actors to find agent IDs.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			name: z.string(),
			type: z.enum(['cron', 'event']),
			config: z
				.record(z.unknown())
				.describe(
					'For cron triggers: { "expression": "*/5 * * * *" }. For event triggers: { "entity_type": "object", "action": "created"|"updated"|"deleted"|"status_changed", "filter": { ... } }',
				),
			action_prompt: z.string(),
			target_actor_id: z.string().uuid(),
			enabled: z.boolean().default(true),
		}),
	},
	update_trigger: {
		description:
			'Update a trigger by ID. Can change name, schedule/event config, action_prompt, target agent, or enabled/disabled state.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
			name: z.string().min(1).optional(),
			config: z.record(z.unknown()).optional(),
			action_prompt: z.string().min(1).optional(),
			target_actor_id: z.string().uuid().optional(),
			enabled: z.boolean().optional(),
		}),
	},
	delete_trigger: {
		description:
			'Delete a trigger by ID. Stops future scheduled or event-driven executions. Does not affect sessions already created by this trigger.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	list_triggers: {
		description:
			'List all triggers (cron and event-based) in the workspace, including schedules, target agents, and enabled/disabled state.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
		}),
	},
	// ─── Sessions ────────────────────────────────────────────
	create_session: {
		description:
			'Spawn a containerized agent execution session. Runtimes: claude-code (Claude Code CLI), codex (OpenAI Codex CLI), custom (your base_image). The agent executes the action_prompt autonomously. Use get_session to check status and logs. For a blocking alternative that waits for completion, use run_agent instead.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			actor_id: z.string().uuid().describe('The actor that will run inside the session'),
			action_prompt: z.string().min(1).describe('The prompt/task for the agent to execute'),
			config: z
				.object({
					base_image: z.string().optional(),
					runtime: z.enum(['claude-code', 'codex', 'custom']).optional(),
					runtime_config: z.record(z.unknown()).optional(),
					timeout_seconds: z.number().int().min(30).max(3600).optional(),
					memory_mb: z.number().int().min(256).max(8192).optional(),
					cpu_shares: z.number().int().min(256).max(4096).optional(),
					env_vars: z.record(z.string()).optional(),
				})
				.optional()
				.describe('Container configuration overrides'),
			trigger_id: z.string().uuid().optional().describe('Trigger that initiated this session'),
			auto_start: z.boolean().default(true).describe('Start the session immediately'),
		}),
	},
	list_sessions: {
		description:
			'List sessions with optional filters. Filter by status (pending, starting, running, paused, completed, failed, timeout) or actor_id. Default limit: 20, ordered newest first.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			status: z
				.enum([
					'pending',
					'starting',
					'running',
					'snapshotting',
					'paused',
					'completed',
					'failed',
					'timeout',
				])
				.optional(),
			actor_id: z.string().uuid().optional(),
			limit: z.number().int().min(1).max(100).default(20),
			offset: z.number().int().min(0).default(0),
		}),
	},
	get_session: {
		description:
			'Get session details by ID. Optionally include log output from the container (stdout/stderr/system).',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
			include_logs: z
				.boolean()
				.default(false)
				.describe('Include log output from the session container'),
			log_limit: z
				.number()
				.int()
				.min(1)
				.max(500)
				.default(100)
				.describe('Max log lines to return (only used when include_logs is true)'),
		}),
	},
	stop_session: {
		description:
			'Stop a running session. Terminates the container — any in-progress work is lost. Use pause_session to save state for later resumption instead.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	pause_session: {
		description:
			'Pause a running session and save a container snapshot. Use resume_session to continue later. Only works on sessions with status "running".',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	resume_session: {
		description:
			'Resume a previously paused session from its saved snapshot. Only works on sessions with status "paused". The session returns to "running" state.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	run_agent: {
		description:
			'High-level tool: create a container agent session, wait for completion, and return the result with logs. This is a blocking call that polls until the session reaches a terminal state (completed/failed/timeout). Use create_session + get_session + get_session_logs separately if you need non-blocking execution.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			actor_id: z.string().uuid().describe('The agent actor that will execute the task'),
			action_prompt: z.string().min(1).describe('The instruction for the agent'),
			config: z
				.object({
					runtime: z.enum(['claude-code', 'codex', 'custom']).optional(),
					timeout_seconds: z.number().int().min(30).max(3600).optional(),
				})
				.optional()
				.describe('Container configuration overrides'),
			poll_interval_seconds: z
				.number()
				.int()
				.min(2)
				.max(30)
				.default(5)
				.describe('How often to check session status'),
			timeout_seconds: z
				.number()
				.int()
				.min(30)
				.max(3700)
				.default(660)
				.describe('Maximum time to wait before giving up (should exceed session timeout)'),
		}),
	},

	// ─── Notifications ───────────────────────────────────────
	create_notification: {
		description:
			'Create a notification for a human in the workspace. Use when the agent needs human input (decision, information), wants to share a strategic recommendation, report good news, or raise an alert.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z
				.enum(['needs_input', 'recommendation', 'good_news', 'alert'])
				.describe(
					'needs_input: agent is blocked and needs a decision. recommendation: agent found something worth attention. good_news: positive outcome to share. alert: something needs attention.',
				),
			title: z.string().min(1),
			content: z.string().optional(),
			metadata: z
				.record(z.unknown())
				.optional()
				.describe(
					'Structured data. Supports "actions" array to define custom action buttons: [{ label: "Button text", response: "value_sent_back", navigate?: { to: "object"|"objects"|"activity"|"agent"|"trigger", id?: "uuid" } }]. Also supports: input_type (confirmation|single_choice|multiple_choice|text), question, options ([{label, value, description?}]), tags, suggestion, urgency_label, meta_text.',
				),
			source_actor_id: z.string().uuid().describe('The agent actor creating this notification'),
			target_actor_id: z
				.string()
				.uuid()
				.optional()
				.describe('Specific human to notify. Omit to broadcast to all workspace members.'),
			object_id: z
				.string()
				.uuid()
				.optional()
				.describe('Related object (insight, bet, or task) this notification is about'),
			session_id: z
				.string()
				.uuid()
				.optional()
				.describe('Session that created this notification, for feedback routing'),
		}),
	},
	list_notifications: {
		description: 'List notifications in the workspace, optionally filtered by status or type.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			status: z
				.enum(['pending', 'seen', 'resolved', 'dismissed'])
				.optional()
				.describe('Filter by notification status'),
			type: z.enum(['needs_input', 'recommendation', 'good_news', 'alert']).optional(),
			limit: z.number().int().min(1).max(100).default(50),
			offset: z.number().int().min(0).default(0),
		}),
	},
	get_notification: {
		description:
			'Get a single notification by ID, including full content and metadata (actions, question, options, urgency).',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	update_notification: {
		description:
			'Update a notification by ID. Can change status (pending, seen, resolved, dismissed) and/or metadata.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
			status: z
				.enum(['pending', 'seen', 'resolved', 'dismissed'])
				.optional()
				.describe('New status for the notification'),
			metadata: z.record(z.unknown()).optional().describe('Metadata to update on the notification'),
		}),
	},
	delete_notification: {
		description:
			'Delete a notification by ID. This is irreversible. Use update_notification to dismiss instead if you want to preserve history.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	// ─── Integrations ─────────────────────────────────────────
	list_integrations: {
		description:
			'List integrations connected to the workspace, including provider name and connection status. Use connect_integration to add or disconnect_integration to remove.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
		}),
	},
	list_integration_providers: {
		description: 'List available integration providers and their supported events',
		inputSchema: z.object({}),
	},
	connect_integration: {
		description:
			'Start an integration connection flow for a provider (e.g. "github"). Returns an install_url that must be opened in a browser to complete the OAuth/installation flow. The callback is handled automatically by the server.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			provider: z
				.string()
				.describe(
					'Provider name (e.g. "github"). Call list_integration_providers to see available providers.',
				),
		}),
	},
	disconnect_integration: {
		description:
			'Disconnect an integration by ID. Revokes OAuth tokens and stops receiving events from this provider. Use list_integrations to find IDs.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	// ─── Extensions ──────────────────────────────────────────
	list_extensions: {
		description:
			'List all available extensions and their status in the workspace. Returns registered extensions (e.g. "work") and any custom extensions defined in the workspace. Each extension bundles one or more object types with statuses, fields, and relationship types. Call this to discover what you can enable or create.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
		}),
	},
	create_extension: {
		description:
			'Add an extension to the workspace. Two modes: (1) Enable a registered extension by ID (e.g. "work"). (2) Create a custom extension — pass id, name, and object_types to define new types from scratch. Call list_extensions first to see available extensions.',
		inputSchema: z.object({
			workspace_id: z.string().uuid().describe('Workspace to add the extension to'),
			id: z
				.string()
				.regex(/^[a-z][a-z0-9_]*$/)
				.describe(
					'Extension ID. For registered extensions: "work". For custom: any lowercase identifier.',
				),
			name: z
				.string()
				.optional()
				.describe(
					'Human-readable name for a custom extension (e.g. "My CRM"). Not needed when installing a known extension.',
				),
			object_types: z
				.array(
					z.object({
						type: z
							.string()
							.regex(/^[a-z][a-z0-9_]*$/)
							.describe('Type identifier (e.g. "lead", "meeting_note")'),
						display_name: z.string().describe('Human-readable name (e.g. "Lead")'),
						statuses: z.array(z.string()).min(1).describe('Valid statuses for this type'),
						fields: z
							.array(
								z.object({
									name: z.string(),
									type: z.enum(['text', 'number', 'date', 'enum', 'boolean']),
									required: z.boolean().default(false),
									values: z
										.array(z.string())
										.optional()
										.describe('Allowed values (only for enum type)'),
								}),
							)
							.default([])
							.describe('Custom metadata fields for this type'),
						relationship_types: z
							.array(z.string())
							.optional()
							.describe('Relationship types to add for this type'),
					}),
				)
				.optional()
				.describe(
					'Object type definitions for a custom extension. Not needed when installing a known extension by ID.',
				),
		}),
	},
	update_extension: {
		description:
			'Update an extension in the workspace. Use this to enable/disable an extension (set enabled: true/false) or to update the object type definitions of a custom extension (modify statuses, fields, display names).',
		inputSchema: z.object({
			workspace_id: z.string().uuid(),
			id: z.string().describe('Extension ID to update'),
			enabled: z
				.boolean()
				.optional()
				.describe('Set to false to disable the extension, true to re-enable it'),
			object_types: z
				.array(
					z.object({
						type: z.string().describe('The type identifier to update'),
						display_name: z.string().optional().describe('New display name'),
						statuses: z
							.array(z.string())
							.min(1)
							.optional()
							.describe('New status list (replaces existing)'),
						fields: z
							.array(
								z.object({
									name: z.string(),
									type: z.enum(['text', 'number', 'date', 'enum', 'boolean']),
									required: z.boolean().default(false),
									values: z.array(z.string()).optional(),
								}),
							)
							.optional()
							.describe('New field definitions (replaces existing)'),
						relationship_types: z
							.array(z.string())
							.optional()
							.describe('Additional relationship types to add'),
					}),
				)
				.optional()
				.describe(
					'Updated object type definitions (PATCH semantics — only provided fields are changed)',
				),
		}),
	},
	delete_extension: {
		description:
			'Remove an extension from the workspace. Deletes its object type definitions from workspace settings. Existing objects of those types are preserved but no new objects can be created with those types. Cannot delete types provided by registered extensions like "work" — disable them instead with update_extension.',
		inputSchema: z.object({
			workspace_id: z.string().uuid(),
			id: z
				.string()
				.describe('Extension ID to remove. Pass the extension ID, not individual type names.'),
		}),
	},
	// ─── Dashboard ──────────────────────────────────────────
	workspace_dashboard: {
		description:
			'Get a comprehensive workspace overview in a single call: objects by type and status, recent activity, active sessions, and team summary. Use this as a quick way to see the state of the workspace without making multiple tool calls.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
		}),
	},
} as const
