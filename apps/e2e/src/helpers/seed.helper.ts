import type { TestAPI } from './api.helper'

/**
 * New workspaces install Knowledge Wiki from the marketplace (its flow object,
 * agents, triggers and checklist tasks). Specs were written against a
 * workspace with nothing installed: the first Flows row on the marketplace
 * page offers Add, loop rows are the ones the spec made, and deleting a flow
 * object fails on the install's foreign key. Uninstalling the install removes
 * the install row, its agents, triggers and skills, and the flow object
 * together, which restores that baseline.
 */
export async function uninstallSeededFlows(api: TestAPI, workspaceId: string): Promise<void> {
	const installs = await api.listInstalledLoops(workspaceId)
	for (const install of installs) {
		await api.uninstallLoop(install.id, workspaceId)
	}
}

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
