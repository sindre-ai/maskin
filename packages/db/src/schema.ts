import type { SessionResult } from '@maskin/shared'
import { sql } from 'drizzle-orm'
import {
	bigint,
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
	apiKey: text('api_key').notNull().unique(),
	passwordHash: text('password_hash'),
	description: text('description'),
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
	onboardingEnabled: boolean('onboarding_enabled').notNull().default(true),
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
	(t) => [
		index('events_ws_created_at_idx').on(t.workspaceId, t.createdAt),
		index('events_ws_entity_id_idx').on(t.workspaceId, t.entityId, t.id),
	],
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
	(t) => [
		uniqueIndex('integrations_ws_provider_external_uniq')
			.on(t.workspaceId, t.provider, t.externalId)
			.where(sql`${t.externalId} IS NOT NULL`),
		uniqueIndex('integrations_ws_provider_null_external_uniq')
			.on(t.workspaceId, t.provider)
			.where(sql`${t.externalId} IS NULL`),
	],
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
		triggerId: uuid('trigger_id').references(() => triggers.id, { onDelete: 'set null' }),
		status: text('status').notNull(),
		containerId: text('container_id'),
		actionPrompt: text('action_prompt').notNull(),
		config: jsonb('config').notNull().default({}),
		interactive: boolean('interactive').notNull().default(false),
		result: jsonb('result').$type<SessionResult>(),
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
		currentActivity: text('current_activity'),
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

// ── Subscriptions ─────────────────────────────────────────────────────────
//
// Polymorphic per-actor subscriptions keyed on (entity_type, entity_id).
// `source` tracks how the row was created — 'author' (creator), 'commenter'
// (auto-attached when they comment), 'mentioned' (auto-attached when they are
// @-mentioned in a comment), or 'manual' (explicit subscribe). Manual/author
// should never be downgraded by a later auto-subscribe.

export const subscriptions = pgTable(
	'subscriptions',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		actorId: uuid('actor_id')
			.references(() => actors.id)
			.notNull(),
		entityType: text('entity_type').notNull(),
		entityId: uuid('entity_id').notNull(),
		source: text('source').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [
		unique('subscriptions_actor_entity_uniq').on(t.actorId, t.entityType, t.entityId),
		index('subscriptions_ws_actor_idx').on(t.workspaceId, t.actorId),
		index('subscriptions_entity_idx').on(t.entityType, t.entityId),
		check(
			'subscriptions_source_check',
			sql`${t.source} IN ('manual', 'author', 'commenter', 'mentioned')`,
		),
	],
)

export type Subscription = typeof subscriptions.$inferSelect
export type NewSubscription = typeof subscriptions.$inferInsert

// ── Read State ────────────────────────────────────────────────────────────
//
// Per-actor high-water-mark per subscribable entity. `last_read_event_id`
// references events.id (bigint, monotonic) so the unread query is just a
// simple `> last_read_event_id`. No FK to events — events are not deleted.

export const readState = pgTable(
	'read_state',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		actorId: uuid('actor_id')
			.references(() => actors.id)
			.notNull(),
		entityType: text('entity_type').notNull(),
		entityId: uuid('entity_id').notNull(),
		lastReadEventId: bigint('last_read_event_id', { mode: 'number' }).notNull(),
		lastReadAt: timestamp('last_read_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [
		unique('read_state_actor_entity_uniq').on(t.actorId, t.entityType, t.entityId),
		index('read_state_ws_actor_idx').on(t.workspaceId, t.actorId),
	],
)

export type ReadState = typeof readState.$inferSelect
export type NewReadState = typeof readState.$inferInsert

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

// ── Files ─────────────────────────────────────────────────────────────────
//
// Workspace-scoped files authored by agents (or members) and shared via a
// stable URL. Bytes live in S3 under `workspaces/{workspaceId}/files/{id}`;
// this row holds metadata only.
export const files = pgTable(
	'files',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspaces.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		description: text('description'),
		mimeType: text('mime_type').notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		storageKey: text('storage_key').notNull(),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index('files_ws_created_at_idx').on(t.workspaceId, t.createdAt),
		index('files_ws_name_idx').on(t.workspaceId, t.name),
	],
)

export type File = typeof files.$inferSelect
export type NewFile = typeof files.$inferInsert

// ── Webhook Deliveries ──────────────────────────────────────────────────────
// Idempotency ledger for inbound webhook deliveries. Each row claims a single
// (provider, external_id, workspace_id) tuple so that retries (which reuse the
// same external_id) are short-circuited per workspace instead of being
// reprocessed and creating duplicate events or duplicate downloaded files.
// The key is per-workspace because a single external install (e.g. one Slack
// team) can be connected to multiple Maskin workspaces, and a failed insert
// for one workspace must not block retries for that workspace while still
// deduping workspaces that already succeeded.

export const webhookDeliveries = pgTable(
	'webhook_deliveries',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		provider: text('provider').notNull(),
		externalId: text('external_id').notNull(),
		workspaceId: uuid('workspace_id').notNull(),
		receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
		// Set when downstream work (events insert + any fan-out side effects) commits.
		// NULL means the claim was committed but its work never finished — either
		// still in flight (within threshold) or orphaned by a restart (past threshold).
		// The reconciler releases orphans so the provider's retry can reprocess them.
		processedAt: timestamp('processed_at', { withTimezone: true }),
	},
	(t) => [
		unique('webhook_deliveries_provider_external_id_workspace_id_uniq').on(
			t.provider,
			t.externalId,
			t.workspaceId,
		),
		index('webhook_deliveries_received_at_idx').on(t.receivedAt),
	],
)

// ── User Display Settings ───────────────────────────────────────────────────
//
// Per-actor, per-workspace, per-object-type display preferences for the
// objects page (sort, filter, view, column visibility, etc.). v1 only ever
// writes/reads the `'default'` row per (actor, object_type) — the `name`
// column is a forward-compatible carve-out for the Board View bet's named
// saved views, which land as additive rows without a migration.
//
// `settings` is opaque JSONB on purpose: the persistence layer is decoupled
// from the display panel's evolving shape. The toolbar (Task 6) owns the
// concrete `{sort, filter, view, viewConfig}` schema.

export const userDisplaySettings = pgTable(
	'user_display_settings',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspaces.id, { onDelete: 'cascade' }),
		actorId: uuid('actor_id')
			.notNull()
			.references(() => actors.id, { onDelete: 'cascade' }),
		objectType: text('object_type').notNull(),
		name: text('name').notNull().default('default'),
		settings: jsonb('settings').notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique('user_display_settings_ws_actor_type_name_uniq').on(
			t.workspaceId,
			t.actorId,
			t.objectType,
			t.name,
		),
		index('user_display_settings_ws_actor_type_idx').on(t.workspaceId, t.actorId, t.objectType),
	],
)

export type UserDisplaySettings = typeof userDisplaySettings.$inferSelect
export type NewUserDisplaySettings = typeof userDisplaySettings.$inferInsert

// ── Workspace Onboarding Prompts ──────────────────────────────────────────────
//
// One row per prompt type per workspace. Written when onboarding is enabled;
// `answered_at` and `object_id` are filled in once the owner replies and the
// knowledge object is created.

export const workspaceOnboardingPrompts = pgTable(
	'workspace_onboarding_prompts',
	{
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspaces.id, { onDelete: 'cascade' }),
		promptType: text('prompt_type').notNull(),
		sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
		answeredAt: timestamp('answered_at', { withTimezone: true }),
		objectId: uuid('object_id'),
	},
	(t) => [
		primaryKey({ columns: [t.workspaceId, t.promptType] }),
		check(
			'workspace_onboarding_prompts_prompt_type_check',
			sql`${t.promptType} IN ('product_vision','icp','first_bet_hypothesis','north_star_metric','customer_evidence')`,
		),
	],
)

export type WorkspaceOnboardingPrompt = typeof workspaceOnboardingPrompts.$inferSelect
export type NewWorkspaceOnboardingPrompt = typeof workspaceOnboardingPrompts.$inferInsert
