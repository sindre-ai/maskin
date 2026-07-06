import { objects } from '@maskin/db/schema'
import { sql } from 'drizzle-orm'
import { check, date, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'

// First-class metadata for customer objects. Sits 1:1 with `objects` rows
// where `type = 'customer'`, keyed on `object_id` (PK + FK CASCADE). Rows stay
// empty in workspaces that never enable the CRM extension, so the base-schema
// E2E path is unaffected.
export const crmCustomerExtras = pgTable(
	'crm_customer_extras',
	{
		objectId: uuid('object_id')
			.primaryKey()
			.references(() => objects.id, { onDelete: 'cascade' }),
		workspaceId: uuid('workspace_id').notNull(),
		segment: text('segment'),
		confidence: text('confidence'),
		lastValidated: date('last_validated'),
		evidenceCount: integer('evidence_count'),
	},
	(t) => [
		check('crm_customer_extras_confidence_ck', sql`${t.confidence} IN ('low','medium','high')`),
		check(
			'crm_customer_extras_evidence_count_nonneg_ck',
			sql`${t.evidenceCount} IS NULL OR ${t.evidenceCount} >= 0`,
		),
		index('crm_customer_extras_ws_segment_idx')
			.on(t.workspaceId, t.segment)
			.where(sql`${t.segment} IS NOT NULL`),
		index('crm_customer_extras_ws_confidence_idx')
			.on(t.workspaceId, t.confidence)
			.where(sql`${t.confidence} IS NOT NULL`),
		index('crm_customer_extras_ws_last_validated_idx')
			.on(t.workspaceId, t.lastValidated)
			.where(sql`${t.lastValidated} IS NOT NULL`),
		index('crm_customer_extras_ws_evidence_count_idx')
			.on(t.workspaceId, t.evidenceCount)
			.where(sql`${t.evidenceCount} IS NOT NULL`),
	],
)

export type CrmCustomerExtras = typeof crmCustomerExtras.$inferSelect
export type NewCrmCustomerExtras = typeof crmCustomerExtras.$inferInsert
