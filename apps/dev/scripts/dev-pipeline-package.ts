// Shared constants and snapshot helpers for the Development Pipeline catalog
// package. The bundle contains Developer + Code Reviewer + Acceptance Validator
// and their four wiring triggers, so workspaces can install the full review
// pipeline in one step.
//
// Exported so the publish script and its tests can share the exact same shape.

import type { actors, triggers } from '@maskin/db/schema'
import {
	DEV_ACTOR_ACCEPTANCE_VALIDATOR,
	DEV_ACTOR_CODE_REVIEWER,
	DEV_ACTOR_DEVELOPER,
	DEV_PACKAGE_DEVELOPMENT_PIPELINE_DESCRIPTION,
	DEV_PACKAGE_DEVELOPMENT_PIPELINE_NAME,
	DEV_PACKAGE_DEVELOPMENT_PIPELINE_SLUG,
	DEV_PACKAGE_USE_CASE_DEVELOPMENT,
	DEV_PACKAGE_VERSION,
	DEV_TRIGGER_ACCEPTANCE_VALIDATOR_TASK_TESTING,
	DEV_TRIGGER_CODE_REVIEWER_PR_SYNCHRONIZE,
	DEV_TRIGGER_CODE_REVIEWER_TASK_IN_REVIEW,
	DEV_TRIGGER_DEVELOPER_TASK_IN_PROGRESS,
} from '@maskin/shared'

export const DEV_PIPELINE_SOURCE_WORKSPACE_ID = 'fe944fe6-7b45-478c-afc7-b889cea63c08'

export const DEV_PIPELINE_PACKAGE = {
	slug: DEV_PACKAGE_DEVELOPMENT_PIPELINE_SLUG,
	name: DEV_PACKAGE_DEVELOPMENT_PIPELINE_NAME,
	version: DEV_PACKAGE_VERSION,
	useCase: DEV_PACKAGE_USE_CASE_DEVELOPMENT,
	description: DEV_PACKAGE_DEVELOPMENT_PIPELINE_DESCRIPTION,
} as const

export const DEV_PIPELINE_ACTOR_IDS = [
	DEV_ACTOR_DEVELOPER,
	DEV_ACTOR_CODE_REVIEWER,
	DEV_ACTOR_ACCEPTANCE_VALIDATOR,
] as const

export const DEV_PIPELINE_TRIGGER_IDS = [
	DEV_TRIGGER_DEVELOPER_TASK_IN_PROGRESS,
	DEV_TRIGGER_CODE_REVIEWER_TASK_IN_REVIEW,
	DEV_TRIGGER_CODE_REVIEWER_PR_SYNCHRONIZE,
	DEV_TRIGGER_ACCEPTANCE_VALIDATOR_TASK_TESTING,
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
		// Carry the source actor id as-is. The install path's rewriteWiring()
		// swaps it for the installed actor's local id using the source_item_id → local_id map.
		targetActorId: row.targetActorId,
		enabled: row.enabled,
	}
}
