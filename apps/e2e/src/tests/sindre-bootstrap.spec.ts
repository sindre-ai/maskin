import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'

test.describe('Sindre: workspace bootstrap + delete guard + reset', () => {
	test('fresh workspace seeds Sindre with isSystem=true and Maskin MCP', async ({ account }) => {
		const workspace = await account.api.createWorkspace(`Sindre E2E Bootstrap ${Date.now()}`)

		const sindreMember = await findSindre(account.api, workspace.id)

		const sindre = await account.api.getActor(sindreMember.id)
		expect(sindre.isSystem).toBe(true)

		const mcpServers = (sindre.tools as { mcpServers?: Record<string, unknown> } | null)?.mcpServers
		expect(mcpServers?.maskin, 'Sindre should ship with the Maskin MCP preconfigured').toBeDefined()
		expect(sindre.systemPrompt ?? '').toContain('You are Sindre')
	})

	test('DELETE on Sindre returns 403 and leaves the actor intact', async ({ account }) => {
		const workspace = await account.api.createWorkspace(`Sindre E2E Delete ${Date.now()}`)
		const sindreMember = await findSindre(account.api, workspace.id)

		const deleteResult = await account.api.deleteActorRaw(sindreMember.id, workspace.id)
		expect(deleteResult.status).toBe(403)

		// Sindre should still exist and still be a workspace member
		const stillExists = await account.api.getActor(sindreMember.id)
		expect(stillExists.isSystem).toBe(true)

		const membersAfter = await account.api.listWorkspaceActors(workspace.id)
		expect(membersAfter.some((m) => m.id === sindreMember.id)).toBe(true)
	})

	test('Reset restores Sindre prompt + Maskin MCP after edits', async ({ account }) => {
		const workspace = await account.api.createWorkspace(`Sindre E2E Reset ${Date.now()}`)
		const sindreMember = await findSindre(account.api, workspace.id)

		const original = await account.api.getActor(sindreMember.id)
		const originalPrompt = original.systemPrompt
		expect(originalPrompt).toBeTruthy()

		// Edit Sindre: custom prompt + remove Maskin MCP
		const customPrompt = 'You are a totally custom Sindre — edited by E2E test.'
		await account.api.updateActor(sindreMember.id, {
			system_prompt: customPrompt,
			tools: { mcpServers: {} },
		})

		const afterEdit = await account.api.getActor(sindreMember.id)
		expect(afterEdit.systemPrompt).toBe(customPrompt)
		const editedMcp = (afterEdit.tools as { mcpServers?: Record<string, unknown> } | null)
			?.mcpServers
		expect(editedMcp?.maskin).toBeUndefined()

		// Reset to factory defaults
		const reset = await account.api.resetActor(sindreMember.id, workspace.id)
		expect(reset.systemPrompt).toBe(originalPrompt)
		const resetMcp = (reset.tools as { mcpServers?: Record<string, unknown> } | null)?.mcpServers
		expect(resetMcp?.maskin, 'Reset should restore the Maskin MCP server').toBeDefined()

		// Re-fetch to confirm persistence
		const afterReset = await account.api.getActor(sindreMember.id)
		expect(afterReset.systemPrompt).toBe(originalPrompt)
		const persistedMcp = (afterReset.tools as { mcpServers?: Record<string, unknown> } | null)
			?.mcpServers
		expect(persistedMcp?.maskin).toBeDefined()
		expect(afterReset.isSystem).toBe(true)
	})
})

async function findSindre(
	api: TestAPI,
	workspaceId: string,
): Promise<{ id: string; name: string; type: string }> {
	const members = await api.listWorkspaceActors(workspaceId)
	const sindre = members.find((m) => m.name === 'Sindre')
	if (!sindre) {
		throw new Error(
			`Sindre not found in workspace ${workspaceId}; members: ${members.map((m) => m.name).join(', ')}`,
		)
	}
	return sindre
}
