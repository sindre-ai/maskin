import { objects } from '@maskin/db/schema'
import { sql } from 'drizzle-orm'
import { boolean, check, date, index, pgTable, text, uuid } from 'drizzle-orm/pg-core'

// First-class metadata for bet objects. Sits 1:1 with `objects` rows where
// `type = 'bet'`, keyed on `object_id` (PK + FK CASCADE). Rows stay empty in
// workspaces that never enable the work extension, so the base-schema E2E path
// is unaffected.
export const workBetExtras = pgTable(
	'work_bet_extras',
	{
		objectId: uuid('object_id')
			.primaryKey()
			.references(() => objects.id, { onDelete: 'cascade' }),
		workspaceId: uuid('workspace_id').notNull(),
		promotionMode: text('promotion_mode'),
		reviewDate: date('review_date'),
		evidenceQuality: text('evidence_quality'),
		feedbackSource: text('feedback_source'),
		mergeBlocked: boolean('merge_blocked'),
		mergeBlockedSince: date('merge_blocked_since'),
	},
	(t) => [
		check(
			'work_bet_extras_promotion_mode_ck',
			sql`${t.promotionMode} IN ('auto','human_approved')`,
		),
		check(
			'work_bet_extras_evidence_quality_ck',
			sql`${t.evidenceQuality} IN ('gut_feeling','evidence_backed')`,
		),
		check(
			'work_bet_extras_feedback_source_ck',
			sql`${t.feedbackSource} IN ('slack','email','meeting','manual','other')`,
		),
		index('work_bet_extras_ws_promotion_mode_idx')
			.on(t.workspaceId, t.promotionMode)
			.where(sql`${t.promotionMode} IS NOT NULL`),
		index('work_bet_extras_ws_review_date_idx')
			.on(t.workspaceId, t.reviewDate)
			.where(sql`${t.reviewDate} IS NOT NULL`),
		index('work_bet_extras_ws_evidence_quality_idx')
			.on(t.workspaceId, t.evidenceQuality)
			.where(sql`${t.evidenceQuality} IS NOT NULL`),
		index('work_bet_extras_ws_feedback_source_idx')
			.on(t.workspaceId, t.feedbackSource)
			.where(sql`${t.feedbackSource} IS NOT NULL`),
		index('work_bet_extras_ws_merge_blocked_idx')
			.on(t.workspaceId, t.mergeBlocked)
			.where(sql`${t.mergeBlocked} IS NOT NULL`),
		index('work_bet_extras_ws_merge_blocked_since_idx')
			.on(t.workspaceId, t.mergeBlockedSince)
			.where(sql`${t.mergeBlockedSince} IS NOT NULL`),
	],
)

export type WorkBetExtras = typeof workBetExtras.$inferSelect
export type NewWorkBetExtras = typeof workBetExtras.$inferInsert
