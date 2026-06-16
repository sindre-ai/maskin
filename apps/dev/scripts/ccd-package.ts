// Shared constants and snapshot helpers for the Customer Continuous Discovery
// catalog package. Exported so the publish script and its tests can share the
// exact same shape — the test asserts that no auth credential or runtime state
// can leak into a snapshot, which is only meaningful if it walks the same
// helper the script writes with.

import type { actors, triggers } from '@maskin/db/schema'
import {
	CCD_ACTOR_CUSTOMER_CURATOR,
	CCD_ACTOR_CUSTOMER_FEEDBACK,
	CCD_ACTOR_INSIGHTS_TRIAGE,
	CCD_ACTOR_PRODUCT_IDEATOR,
	CCD_PACKAGE_DESCRIPTION,
	CCD_PACKAGE_NAME,
	CCD_PACKAGE_SLUG,
	CCD_PACKAGE_USE_CASE,
	CCD_PACKAGE_VERSION,
} from '@maskin/shared'

export const CCD_SOURCE_WORKSPACE_ID = 'fe944fe6-7b45-478c-afc7-b889cea63c08'

export const CCD_PACKAGE = {
	slug: CCD_PACKAGE_SLUG,
	name: CCD_PACKAGE_NAME,
	version: CCD_PACKAGE_VERSION,
	useCase: CCD_PACKAGE_USE_CASE,
	description: CCD_PACKAGE_DESCRIPTION,
} as const

export const CCD_ACTOR_IDS = [
	CCD_ACTOR_CUSTOMER_FEEDBACK, // Customer Feedback Agent
	CCD_ACTOR_INSIGHTS_TRIAGE, // Insights Triage Agent
	CCD_ACTOR_PRODUCT_IDEATOR, // Product Ideator
	CCD_ACTOR_CUSTOMER_CURATOR, // Customer Curator
] as const

export const CCD_TRIGGER_IDS = [
	'f1d1c055-432f-462a-a177-f27ae7bc5c0e', // Bug Fix Merged → Reply in Slack
	'34fa2aa8-75c0-4919-9170-27fed672528e', // Deploy Confirmed → Customer Reply
	'f41f513a-5a58-4ab2-aab3-83e002f2c3b7', // Insight Created → Synthesizer Triage
	'a7470be0-05c7-46b9-a003-f48b43a1a6b4', // Insight Updated → Synthesizer Re-triage
	'd458e38d-d486-4da3-8c89-74f989b2f104', // Daily Synthesizer Sweep
	'b65382c4-0287-4aa8-a477-9a61296e5702', // Weekly Synthesizer Digest
	'28c063e2-4a39-4f5a-883d-5f5ef6a29a9e', // Daily Product Ideation — 3 Bet Candidates
	'6bcede7c-2095-43b7-b9a1-82aeceab340f', // Insight Clustered → Update Customer
	'a8862b32-31c2-4714-8c47-34d61d73aee2', // Daily Customer Roster Sweep
] as const

export function actorSnapshot(row: typeof actors.$inferSelect): Record<string, unknown> {
	// apiKey, memory, agentState, isSystem, createdBy, timestamps are
	// install-time / runtime state — they never belong in a publish.
	return {
		type: row.type,
		name: row.name,
		description: row.description,
		systemPrompt: row.systemPrompt,
		llmProvider: row.llmProvider,
		llmConfig: row.llmConfig,
		tools: row.tools,
	}
}

export function triggerSnapshot(row: typeof triggers.$inferSelect): Record<string, unknown> {
	return {
		name: row.name,
		type: row.type,
		config: row.config,
		actionPrompt: row.actionPrompt,
		// Carry the source actor id as-is. T3's rewriteWiring() swaps it for the
		// installed actor's local id using the source_item_id → local_id map.
		targetActorId: row.targetActorId,
		enabled: row.enabled,
	}
}
