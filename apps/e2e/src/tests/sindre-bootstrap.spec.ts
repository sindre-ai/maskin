import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'

const CHIEF_OF_STAFF = 'Chief of Staff'

test.describe('Chief of Staff: workspace bootstrap + delete guard + reset', () => {
	test('fresh workspace seeds the Chief of Staff and nothing else', async ({ account }) => {
		const workspace = await account.api.createWorkspace(
			`Default Agents E2E Bootstrap ${Date.now()}`,
		)

		const chief = await findChiefOfStaff(account.api, workspace.id)
		expect(chief).toBeDefined()

		// The post-commit bootstrap is async — give it time to seed anything it
		// would have, then assert it didn't add a roster the owner never asked for.
		await new Promise((r) => setTimeout(r, 3000))
		const members = await account.api.listWorkspaceActors(workspace.id)
		const agentNames = members.filter((m) => m.type === 'agent').map((m) => m.name)
		expect(agentNames).toEqual([CHIEF_OF_STAFF])
	})

	test('fresh workspace seeds Chief of Staff with isSystem=true and Maskin MCP', async ({
		account,
	}) => {
		const workspace = await account.api.createWorkspace(
			`Chief of Staff E2E Bootstrap ${Date.now()}`,
		)

		const chiefMember = await findChiefOfStaff(account.api, workspace.id)

		const chief = await account.api.getActor(chiefMember.id)
		expect(chief.isSystem).toBe(true)

		const mcpServers = (chief.tools as { mcpServers?: Record<string, unknown> } | null)?.mcpServers
		expect(
			mcpServers?.maskin,
			'Chief of Staff should ship with the Maskin MCP preconfigured',
		).toBeDefined()
		expect(chief.system_prompt ?? '').toContain('Chief of Staff')
	})

	test('DELETE on Chief of Staff returns 403 and leaves the actor intact', async ({ account }) => {
		const workspace = await account.api.createWorkspace(`Chief of Staff E2E Delete ${Date.now()}`)
		const chiefMember = await findChiefOfStaff(account.api, workspace.id)

		const deleteResult = await account.api.deleteActorRaw(chiefMember.id, workspace.id)
		expect(deleteResult.status).toBe(403)

		// Chief of Staff should still exist and still be a workspace member
		const stillExists = await account.api.getActor(chiefMember.id)
		expect(stillExists.isSystem).toBe(true)

		const membersAfter = await account.api.listWorkspaceActors(workspace.id)
		expect(membersAfter.some((m) => m.id === chiefMember.id)).toBe(true)
	})

	test('Reset restores Chief of Staff prompt + Maskin MCP after edits', async ({ account }) => {
		const workspace = await account.api.createWorkspace(`Chief of Staff E2E Reset ${Date.now()}`)
		const chiefMember = await findChiefOfStaff(account.api, workspace.id)

		const original = await account.api.getActor(chiefMember.id)
		const originalPrompt = original.system_prompt
		expect(originalPrompt).toBeTruthy()

		// Edit Chief of Staff: custom prompt + remove Maskin MCP
		const customPrompt = 'You are a totally custom Chief of Staff — edited by E2E test.'
		await account.api.updateActor(chiefMember.id, {
			system_prompt: customPrompt,
			tools: { mcpServers: {} },
		})

		const afterEdit = await account.api.getActor(chiefMember.id)
		expect(afterEdit.system_prompt).toBe(customPrompt)
		const editedMcp = (afterEdit.tools as { mcpServers?: Record<string, unknown> } | null)
			?.mcpServers
		expect(editedMcp?.maskin).toBeUndefined()

		// Reset to factory defaults
		const reset = await account.api.resetActor(chiefMember.id, workspace.id)
		expect(reset.name).toBe(CHIEF_OF_STAFF)
		expect(reset.system_prompt).toBe(originalPrompt)
		const resetMcp = (reset.tools as { mcpServers?: Record<string, unknown> } | null)?.mcpServers
		expect(resetMcp?.maskin, 'Reset should restore the Maskin MCP server').toBeDefined()

		// Re-fetch to confirm persistence
		const afterReset = await account.api.getActor(chiefMember.id)
		expect(afterReset.name).toBe(CHIEF_OF_STAFF)
		expect(afterReset.system_prompt).toBe(originalPrompt)
		const persistedMcp = (afterReset.tools as { mcpServers?: Record<string, unknown> } | null)
			?.mcpServers
		expect(persistedMcp?.maskin).toBeDefined()
		expect(afterReset.isSystem).toBe(true)
	})
})

async function findChiefOfStaff(
	api: TestAPI,
	workspaceId: string,
): Promise<{ id: string; name: string; type: string }> {
	const members = await api.listWorkspaceActors(workspaceId)
	const chief = members.find((m) => m.name === CHIEF_OF_STAFF)
	if (!chief) {
		throw new Error(
			`Chief of Staff not found in workspace ${workspaceId}; members: ${members.map((m) => m.name).join(', ')}`,
		)
	}
	return chief
}
