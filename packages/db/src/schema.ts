import { sql } from 'drizzle-orm'
import {
	bigserial,
	boolean,
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core'

// ── Actors ──────────────────────────────────────────────────────────────────

export const actors = pgTable('actors', {
	id: uuid('id').defaultRandom().primaryKey(),
	type: text('type').notNull(),
	name: text('name').notNull(),
	email: text('email').unique(),
	apiKey: text('api_key'),
	passwordHash: text('password_hash'),
	systemPrompt: text('system_prompt'),
	tools: jsonb('tools'),
	memory: jsonb('memory'),
	llmProvider: text('llm_provider'),
	llmConfig: jsonb('llm_config'),
	isSystem: boolean('is_system').notNull().default(false),
	// biome-ignore lint/suspicious/noExplicitAny: self-referential FK requires type escape
	createdBy: uuid('created_by').references((): any => actors.id),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

// ── Workspaces ──────────────────────────────────────────────────────────────

export const workspaces = pgTable('workspaces', {
	id: uuid('id').defaultRandom().primaryKey(),
	name: text('name').notNull(),
	settings: jsonb('settings').notNull().default({}),
	createdBy: uuid('created_by').references(() => actors.id),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

// ── Workspace Members ───────────────────────────────────────────────────────

export const workspaceMembers = pgTable(
	'workspace_members',
	{
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		actorId: uuid('actor_id')
			.references(() => actors.id)
			.notNull(),
		role: text('role').notNull(),
		joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.workspaceId, t.actorId] })],
)

// ── Objects ─────────────────────────────────────────────────────────────────

export const objects = pgTable(
	'objects',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		type: text('type').notNull(),
		title: text('title'),
		content: text('content'),
		status: text('status').notNull(),
		metadata: jsonb('metadata'),
		owner: uuid('owner').references(() => actors.id),
		activeSessionId: uuid('active_session_id'),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [index('objects_ws_type_status_idx').on(t.workspaceId, t.type, t.status)],
)

// ── Relationships ───────────────────────────────────────────────────────────

export const relationships = pgTable(
	'relationships',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		sourceType: text('source_type').notNull(),
		sourceId: uuid('source_id').notNull(),
		targetType: text('target_type').notNull(),
		targetId: uuid('target_id').notNull(),
		type: text('type').notNull(),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [unique('relationships_src_tgt_type_uniq').on(t.sourceId, t.targetId, t.type)],
)

// ── Events ──────────────────────────────────────────────────────────────────

export const events = pgTable(
	'events',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		actorId: uuid('actor_id')
			.references(() => actors.id)
			.notNull(),
		action: text('action').notNull(),
		entityType: text('entity_type').notNull(),
		entityId: uuid('entity_id').notNull(),
		data: jsonb('data'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [index('events_ws_created_at_idx').on(t.workspaceId, t.createdAt)],
)

// ── Integrations ───────────────────────────────────────────────────────────

export const integrations = pgTable(
	'integrations',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		provider: text('provider').notNull(),
		status: text('status').notNull(),
		externalId: text('external_id'),
		credentials: text('credentials').notNull(),
		config: jsonb('config').notNull().default({}),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [unique('integrations_ws_provider_uniq').on(t.workspaceId, t.provider)],
)

// ── Triggers ────────────────────────────────────────────────────────────────

export const triggers = pgTable('triggers', {
	id: uuid('id').defaultRandom().primaryKey(),
	workspaceId: uuid('workspace_id')
		.references(() => workspaces.id)
		.notNull(),
	name: text('name').notNull(),
	type: text('type').notNull(),
	config: jsonb('config').notNull(),
	actionPrompt: text('action_prompt').notNull(),
	targetActorId: uuid('target_actor_id')
		.references(() => actors.id)
		.notNull(),
	enabled: boolean('enabled').notNull().default(true),
	createdBy: uuid('created_by')
		.references(() => actors.id)
		.notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

// ── Sessions ───────────────────────────────────────────────────────────────

export const sessions = pgTable(
	'sessions',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		actorId: uuid('actor_id')
			.references(() => actors.id)
			.notNull(),
		triggerId: uuid('trigger_id').references(() => triggers.id),
		threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'set null' }),
		status: text('status').notNull(),
		containerId: text('container_id'),
		actionPrompt: text('action_prompt').notNull(),
		config: jsonb('config').notNull().default({}),
		interactive: boolean('interactive').notNull().default(false),
		result: jsonb('result'),
		snapshotPath: text('snapshot_path'),
		startedAt: timestamp('started_at', { withTimezone: true }),
		completedAt: timestamp('completed_at', { withTimezone: true }),
		timeoutAt: timestamp('timeout_at', { withTimezone: true }),
		totalCostUsd: numeric('total_cost_usd', { precision: 12, scale: 6 }),
		inputTokens: integer('input_tokens'),
		outputTokens: integer('output_tokens'),
		cacheCreationInputTokens: integer('cache_creation_input_tokens'),
		cacheReadInputTokens: integer('cache_read_input_tokens'),
		durationMs: integer('duration_ms'),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [
		index('sessions_ws_status_idx').on(t.workspaceId, t.status),
		index('sessions_actor_idx').on(t.actorId),
		index('sessions_actor_completed_idx')
			.on(t.actorId, t.completedAt)
			.where(sql`${t.completedAt} IS NOT NULL`),
		index('sessions_thread_id_idx').on(t.threadId),
	],
)

// ── Session Logs ───────────────────────────────────────────────────────────

export const sessionLogs = pgTable(
	'session_logs',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		sessionId: uuid('session_id')
			.references(() => sessions.id)
			.notNull(),
		stream: text('stream').notNull(),
		content: text('content').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [index('session_logs_session_idx').on(t.sessionId, t.createdAt)],
)

// ── Agent Files ────────────────────────────────────────────────────────────

export const agentFiles = pgTable(
	'agent_files',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		actorId: uuid('actor_id')
			.references(() => actors.id)
			.notNull(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		fileType: text('file_type').notNull(),
		path: text('path').notNull(),
		storageKey: text('storage_key').notNull(),
		sizeBytes: integer('size_bytes'),
		sessionId: uuid('session_id').references(() => sessions.id),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [
		index('agent_files_actor_type_idx').on(t.actorId, t.fileType),
		unique('agent_files_actor_path_uniq').on(t.actorId, t.workspaceId, t.path),
	],
)

// ── Workspace Skills ───────────────────────────────────────────────────────

export const workspaceSkills = pgTable(
	'workspace_skills',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspaces.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		description: text('description'),
		content: text('content').notNull(),
		storageKey: text('storage_key').notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		isValid: boolean('is_valid').notNull().default(true),
		createdBy: uuid('created_by').references(() => actors.id),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex('workspace_skills_ws_name_uniq').on(t.workspaceId, t.name),
		check('workspace_skills_name_format', sql`${t.name} ~ '^[a-z0-9-]{1,64}$'`),
	],
)

export type WorkspaceSkill = typeof workspaceSkills.$inferSelect
export type NewWorkspaceSkill = typeof workspaceSkills.$inferInsert

// ── Agent Skills ───────────────────────────────────────────────────────────

export const agentSkills = pgTable(
	'agent_skills',
	{
		actorId: uuid('actor_id')
			.notNull()
			.references(() => actors.id, { onDelete: 'cascade' }),
		workspaceSkillId: uuid('workspace_skill_id')
			.notNull()
			.references(() => workspaceSkills.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.actorId, t.workspaceSkillId] }),
		index('agent_skills_actor_idx').on(t.actorId),
	],
)

export type AgentSkill = typeof agentSkills.$inferSelect
export type NewAgentSkill = typeof agentSkills.$inferInsert

// ── Imports ───────────────────────────────────────────────────────────

export const imports = pgTable(
	'imports',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		status: text('status')
			.$type<'uploading' | 'mapping' | 'importing' | 'completed' | 'failed'>()
			.notNull(),
		fileName: text('file_name').notNull(),
		fileType: text('file_type').notNull(),
		fileStorageKey: text('file_storage_key').notNull(),
		totalRows: integer('total_rows'),
		processedRows: integer('processed_rows').notNull().default(0),
		successCount: integer('success_count').notNull().default(0),
		errorCount: integer('error_count').notNull().default(0),
		mapping: jsonb('mapping'),
		preview: jsonb('preview'),
		errors: jsonb('errors'),
		source: text('source').notNull().default('file'),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
		completedAt: timestamp('completed_at', { withTimezone: true }),
	},
	(t) => [
		index('imports_ws_status_idx').on(t.workspaceId, t.status),
		check(
			'imports_status_check',
			sql`${t.status} IN ('uploading', 'mapping', 'importing', 'completed', 'failed')`,
		),
	],
)

// ── MCP Telemetry ─────────────────────────────────────────────────────────
//
// Records the two events the MCP server emits on every response:
//   - event_type='tool_call'  — per tool response, with hasRichRender + durationMs.
//                                Powers the bet's "50%+ of MCP tool calls render
//                                a rich card" success metric.
//   - event_type='mutation'   — per successful update_objects / delete_object
//                                call. Powers the "20%+ of MCP sessions include
//                                at least one in-chat object mutation" metric.
//
// `session_id` is whatever stable identifier the MCP transport surfaces (the
// MCP session id when present, else a per-process correlation id) and is text,
// not uuid, because we do not control the upstream id format.
export const mcpTelemetry = pgTable(
	'mcp_telemetry',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		// Aggregate-only metric rows — cascade-delete with the workspace so
		// dashboards never read telemetry for a workspace the user has removed.
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id, { onDelete: 'cascade' })
			.notNull(),
		eventType: text('event_type').notNull(),
		toolName: text('tool_name').notNull(),
		sessionId: text('session_id'),
		hasRichRender: boolean('has_rich_render'),
		durationMs: integer('duration_ms'),
		objectType: text('object_type'),
		mutationKind: text('mutation_kind'),
		data: jsonb('data'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index('mcp_telemetry_ws_created_at_idx').on(t.workspaceId, t.createdAt),
		index('mcp_telemetry_ws_event_type_idx').on(t.workspaceId, t.eventType, t.createdAt),
	],
)

// ── Threads ───────────────────────────────────────────────────────────────

export const threads = pgTable(
	'threads',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id, { onDelete: 'cascade' })
			.notNull(),
		focusObjectId: uuid('focus_object_id').references(() => objects.id, { onDelete: 'set null' }),
		visibility: text('visibility').notNull().default('channel'),
		state: text('state').notNull().default('open'),
		kind: text('kind').notNull().default('discussion'),
		title: text('title').notNull(),
		resolvedAt: timestamp('resolved_at', { withTimezone: true }),
		resolvedBy: uuid('resolved_by').references(() => actors.id),
		resolution: text('resolution'),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index('threads_workspace_id_idx').on(t.workspaceId),
		index('threads_focus_object_id_idx').on(t.focusObjectId),
	],
)

export type Thread = typeof threads.$inferSelect
export type NewThread = typeof threads.$inferInsert

export const threadParticipants = pgTable(
	'thread_participants',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		threadId: uuid('thread_id')
			.references(() => threads.id, { onDelete: 'cascade' })
			.notNull(),
		actorId: uuid('actor_id')
			.references(() => actors.id, { onDelete: 'cascade' })
			.notNull(),
		kind: text('kind').notNull(),
		joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique('thread_participants_thread_actor_uniq').on(t.threadId, t.actorId),
		index('thread_participants_thread_id_idx').on(t.threadId),
		index('thread_participants_actor_id_idx').on(t.actorId),
	],
)

export type ThreadParticipant = typeof threadParticipants.$inferSelect
export type NewThreadParticipant = typeof threadParticipants.$inferInsert

export const threadEvents = pgTable(
	'thread_events',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		threadId: uuid('thread_id')
			.references(() => threads.id, { onDelete: 'cascade' })
			.notNull(),
		actorId: uuid('actor_id')
			.references(() => actors.id)
			.notNull(),
		kind: text('kind').notNull(),
		body: text('body'),
		metadata: jsonb('metadata'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index('thread_events_thread_id_idx').on(t.threadId),
		index('thread_events_actor_id_idx').on(t.actorId),
	],
)

export type ThreadEvent = typeof threadEvents.$inferSelect
export type NewThreadEvent = typeof threadEvents.$inferInsert

// ── Notifications ─────────────────────────────────────────────────────────

export const notifications = pgTable(
	'notifications',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		type: text('type').notNull(),
		title: text('title').notNull(),
		content: text('content'),
		metadata: jsonb('metadata'),
		sourceActorId: uuid('source_actor_id')
			.references(() => actors.id)
			.notNull(),
		targetActorId: uuid('target_actor_id').references(() => actors.id),
		objectId: uuid('object_id').references(() => objects.id, { onDelete: 'set null' }),
		sessionId: uuid('session_id').references(() => sessions.id),
		status: text('status').notNull(),
		resolvedAt: timestamp('resolved_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [
		index('notifications_ws_status_idx').on(t.workspaceId, t.status),
		index('notifications_target_actor_idx').on(t.targetActorId, t.status),
	],
)
