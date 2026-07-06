import { objects } from '@maskin/db/schema'
import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// First-class metadata for knowledge objects. Sits 1:1 with `objects` rows
// where `type = 'knowledge'`, keyed on `object_id` (PK + FK CASCADE). Rows
// stay empty in workspaces that never enable the knowledge extension, so the
// base-schema E2E path is unaffected.
export const knowledgeExtras = pgTable(
	'knowledge_extras',
	{
		objectId: uuid('object_id')
			.primaryKey()
			.references(() => objects.id, { onDelete: 'cascade' }),
		workspaceId: uuid('workspace_id').notNull(),
		tValid: timestamp('t_valid', { withTimezone: true }).notNull().defaultNow(),
		// NULL = live. Non-NULL = superseded / contradicted / deprecated at that instant.
		tInvalid: timestamp('t_invalid', { withTimezone: true }),
		confidence: text('confidence'),
		verificationStatus: text('verification_status').notNull().default('unverified'),
		writerType: text('writer_type').notNull(),
		provenanceType: text('provenance_type').notNull(),
		provenanceRef: jsonb('provenance_ref'),
	},
	(t) => [
		check('knowledge_extras_confidence_ck', sql`${t.confidence} IN ('low','medium','high')`),
		check(
			'knowledge_extras_verification_status_ck',
			sql`${t.verificationStatus} IN ('unverified','pending','verified','deprecated','contested')`,
		),
		check('knowledge_extras_writer_type_ck', sql`${t.writerType} IN ('human','agent','system')`),
		check(
			'knowledge_extras_provenance_type_ck',
			sql`${t.provenanceType} IN ('insight','meeting','slack','agent-write','manual','imported')`,
		),
		index('knowledge_extras_ws_t_valid_idx')
			.on(t.workspaceId, t.tValid)
			.where(sql`${t.tInvalid} IS NULL`),
		index('knowledge_extras_ws_confidence_idx')
			.on(t.workspaceId, t.confidence)
			.where(sql`${t.tInvalid} IS NULL`),
		index('knowledge_extras_ws_verification_status_idx')
			.on(t.workspaceId, t.verificationStatus)
			.where(sql`${t.tInvalid} IS NULL`),
		index('knowledge_extras_ws_writer_type_idx')
			.on(t.workspaceId, t.writerType)
			.where(sql`${t.tInvalid} IS NULL`),
		index('knowledge_extras_ws_provenance_type_idx')
			.on(t.workspaceId, t.provenanceType)
			.where(sql`${t.tInvalid} IS NULL`),
	],
)

export type KnowledgeExtras = typeof knowledgeExtras.$inferSelect
export type NewKnowledgeExtras = typeof knowledgeExtras.$inferInsert
