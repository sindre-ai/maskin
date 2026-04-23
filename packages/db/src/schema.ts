import { sql } from 'drizzle-orm'
import {
	bigserial,
	boolean,
	check,
	index,
	integer,
	jsonb,
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
		status: text('status').notNull(),
		containerId: text('container_id'),
		actionPrompt: text('action_prompt').notNull(),
		config: jsonb('config').notNull().default({}),
		result: jsonb('result'),
		snapshotPath: text('snapshot_path'),
		startedAt: timestamp('started_at', { withTimezone: true }),
		completedAt: timestamp('completed_at', { withTimezone: true }),
		timeoutAt: timestamp('timeout_at', { withTimezone: true }),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [
		index('sessions_ws_status_idx').on(t.workspaceId, t.status),
		index('sessions_actor_idx').on(t.actorId),
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
		createdBy: uuid('created_by').references(() => actors.id),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [uniqueIndex('workspace_skills_ws_name_uniq').on(t.workspaceId, t.name)],
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
