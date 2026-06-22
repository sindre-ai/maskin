import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'

test.describe('Workspace Coach: workspace bootstrap + delete guard + reset', () => {
	test('fresh workspace seeds all three default agents (Coach, Driver, Strategist)', async ({
		account,
	}) => {
		const workspace = await account.api.createWorkspace(
			`Default Agents E2E Bootstrap ${Date.now()}`,
		)

		// Driver and Strategist are seeded async — poll until they appear.
		const driver = await findAgentWithRetry(account.api, workspace.id, 'Workspace Driver')
		const strategist = await findAgentWithRetry(account.api, workspace.id, 'Strategist')

		expect(driver).toBeDefined()
		expect(strategist).toBeDefined()
	})

	test('fresh workspace seeds Workspace Coach with isSystem=true and Maskin MCP', async ({
		account,
	}) => {
		const workspace = await account.api.createWorkspace(
			`Workspace Coach E2E Bootstrap ${Date.now()}`,
		)

		const coachMember = await findWorkspaceCoach(account.api, workspace.id)

		const coach = await account.api.getActor(coachMember.id)
		expect(coach.isSystem).toBe(true)

		const mcpServers = (coach.tools as { mcpServers?: Record<string, unknown> } | null)?.mcpServers
		expect(
			mcpServers?.maskin,
			'Workspace Coach should ship with the Maskin MCP preconfigured',
		).toBeDefined()
		expect(coach.system_prompt ?? '').toContain('You are the Workspace Coach')
	})

	test('DELETE on Workspace Coach returns 403 and leaves the actor intact', async ({ account }) => {
		const workspace = await account.api.createWorkspace(`Workspace Coach E2E Delete ${Date.now()}`)
		const coachMember = await findWorkspaceCoach(account.api, workspace.id)

		const deleteResult = await account.api.deleteActorRaw(coachMember.id, workspace.id)
		expect(deleteResult.status).toBe(403)

		// Workspace Coach should still exist and still be a workspace member
		const stillExists = await account.api.getActor(coachMember.id)
		expect(stillExists.isSystem).toBe(true)

		const membersAfter = await account.api.listWorkspaceActors(workspace.id)
		expect(membersAfter.some((m) => m.id === coachMember.id)).toBe(true)
	})

	test('Reset restores Workspace Coach prompt + Maskin MCP after edits', async ({ account }) => {
		const workspace = await account.api.createWorkspace(`Workspace Coach E2E Reset ${Date.now()}`)
		const coachMember = await findWorkspaceCoach(account.api, workspace.id)

		const original = await account.api.getActor(coachMember.id)
		const originalPrompt = original.system_prompt
		expect(originalPrompt).toBeTruthy()

		// Edit Workspace Coach: custom prompt + remove Maskin MCP
		const customPrompt = 'You are a totally custom Workspace Coach — edited by E2E test.'
		await account.api.updateActor(coachMember.id, {
			system_prompt: customPrompt,
			tools: { mcpServers: {} },
		})

		const afterEdit = await account.api.getActor(coachMember.id)
		expect(afterEdit.system_prompt).toBe(customPrompt)
		const editedMcp = (afterEdit.tools as { mcpServers?: Record<string, unknown> } | null)
			?.mcpServers
		expect(editedMcp?.maskin).toBeUndefined()

		// Reset to factory defaults
		const reset = await account.api.resetActor(coachMember.id, workspace.id)
		expect(reset.system_prompt).toBe(originalPrompt)
		const resetMcp = (reset.tools as { mcpServers?: Record<string, unknown> } | null)?.mcpServers
		expect(resetMcp?.maskin, 'Reset should restore the Maskin MCP server').toBeDefined()

		// Re-fetch to confirm persistence
		const afterReset = await account.api.getActor(coachMember.id)
		expect(afterReset.system_prompt).toBe(originalPrompt)
		const persistedMcp = (afterReset.tools as { mcpServers?: Record<string, unknown> } | null)
			?.mcpServers
		expect(persistedMcp?.maskin).toBeDefined()
		expect(afterReset.isSystem).toBe(true)
	})
})

async function findWorkspaceCoach(
	api: TestAPI,
	workspaceId: string,
): Promise<{ id: string; name: string; type: string }> {
	const members = await api.listWorkspaceActors(workspaceId)
	const coach = members.find((m) => m.name === 'Workspace Coach')
	if (!coach) {
		throw new Error(
			`Workspace Coach not found in workspace ${workspaceId}; members: ${members.map((m) => m.name).join(', ')}`,
		)
	}
	return coach
}

// Driver and Strategist are seeded async after workspace creation — poll until they appear.
async function findAgentWithRetry(
	api: TestAPI,
	workspaceId: string,
	name: string,
	{ attempts = 10, delayMs = 500 } = {},
): Promise<{ id: string; name: string; type: string }> {
	for (let i = 0; i < attempts; i++) {
		const members = await api.listWorkspaceActors(workspaceId)
		const agent = members.find((m) => m.name === name)
		if (agent) return agent
		await new Promise((r) => setTimeout(r, delayMs))
	}
	const members = await api.listWorkspaceActors(workspaceId)
	throw new Error(
		`Agent "${name}" not found in workspace ${workspaceId} after ${attempts} attempts; members: ${members.map((m) => m.name).join(', ')}`,
	)
}
