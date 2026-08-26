import type { TestAPI } from './api.helper'

/**
 * Every workspace is provisioned with a default roster of agents, triggers,
 * and loops (`DEFAULT_WORKSPACE_LOOPS` / `DEFAULT_WORKSPACE_TRIGGERS` in
 * `provisionWorkspace`). A spec that asserts an empty-state surface — or that
 * locates a single loop row / trigger row it created itself — has to strip
 * that roster first, or it is asserting against a workspace that was never
 * empty and whose rows collide under Playwright's strict mode.
 */
export async function clearSeededAutomations(api: TestAPI, workspaceId: string): Promise<void> {
	const triggers = await api.listTriggers(workspaceId)
	await Promise.all(triggers.map((trigger) => api.deleteTrigger(trigger.id, workspaceId)))

	const objects = await api.listObjects(workspaceId)
	await Promise.all(
		objects
			.filter((object) => object.type === 'loop')
			.map((object) => api.deleteObject(object.id, workspaceId)),
	)
}
