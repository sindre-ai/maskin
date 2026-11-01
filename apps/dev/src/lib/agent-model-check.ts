import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { isEnterprise } from './enterprise'
import { hasConfiguredOAuthSlot } from './llm-routing'
import { getCatalogModel, listRoutableModels } from './model-catalog'
import type { WorkspaceSettings } from './types'

function modelList(enterprise: boolean): string {
	return listRoutableModels(enterprise)
		.map((m) => m.id)
		.join(', ')
}

/**
 * Why an agent in this workspace cannot be set to `model`, in plain words, or
 * null when it can. Nothing is accepted that the resolver would then ignore.
 *
 * `honouredAsTyped` is the enterprise bring-your-own-key case: the agent's own
 * key, or the workspace's Anthropic key when no subscription or custom endpoint
 * comes first. Those routes pass the model to the provider as typed, so the
 * catalog does not apply to them.
 */
export function modelRefusal(params: {
	model: string
	enterprise: boolean
	honouredAsTyped: boolean
}): string | null {
	const { model, enterprise, honouredAsTyped } = params
	if (honouredAsTyped) return null
	const entry = getCatalogModel(model)
	if (!entry) {
		return `"${model}" is not a model Maskin offers. Models this workspace can run: ${modelList(enterprise)}.`
	}
	if (entry.route === 'openrouter' && enterprise) {
		return `${entry.displayName} runs on Maskin's funded route, which enterprise workspaces do not use. Models this workspace can run: ${modelList(enterprise)}.`
	}
	if (entry.route === 'subscription' && !enterprise) {
		return `${entry.displayName} needs a connected Claude subscription, which only enterprise workspaces have. Models this workspace can run: ${modelList(enterprise)}.`
	}
	return null
}

/**
 * Loads the workspace and applies `modelRefusal`. Skips (returns null) when
 * there is no model to check, the model is unchanged from what is stored, or
 * the workspace is unknown — a stored value is never re-judged on an unrelated
 * edit.
 */
export async function checkAgentModelForWorkspace(
	db: Database,
	params: {
		workspaceId: string | null | undefined
		model: unknown
		storedModel: unknown
		hasAgentKey: boolean
	},
): Promise<string | null> {
	const model = typeof params.model === 'string' ? params.model.trim() : ''
	if (!model || !params.workspaceId) return null
	if (typeof params.storedModel === 'string' && params.storedModel.trim() === model) return null
	const [ws] = await db
		.select({
			settings: workspaces.settings,
			enterpriseGranted: workspaces.enterpriseGranted,
			billingOwnerId: workspaces.billingOwnerId,
		})
		.from(workspaces)
		.where(eq(workspaces.id, params.workspaceId))
		.limit(1)
	if (!ws) return null
	const enterprise = isEnterprise(ws)
	const settings = (ws.settings as WorkspaceSettings | null) ?? ({} as WorkspaceSettings)
	const workspaceKeyFirst =
		Boolean(settings.llm_keys?.anthropic) &&
		!hasConfiguredOAuthSlot(settings.claude_oauth) &&
		!settings.custom_llm?.enabled
	return modelRefusal({
		model,
		enterprise,
		honouredAsTyped: enterprise && (params.hasAgentKey || workspaceKeyFirst),
	})
}
