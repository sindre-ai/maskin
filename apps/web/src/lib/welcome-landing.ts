import { type WorkspaceResponse, api } from '@/lib/api'

/**
 * Where a new person lands: the chat the Chief of Staff opened with its welcome. If that chat
 * could not be opened, New Chat still has the Chief of Staff to talk to.
 */
export async function welcomeLandingPath(workspaceId: string): Promise<string> {
	let landing = `/${workspaceId}/chats/new`
	try {
		const { conversations } = await api.conversations.list(workspaceId, { limit: '1' })
		if (conversations[0]) landing = `/${workspaceId}/chats/${conversations[0].id}`
	} catch (err) {
		console.error('[maskin] failed to find the welcome chat', err)
	}
	return landing
}

/**
 * A workspace the server made while the card step is on waits for a card before anything runs, so
 * the card step opens instead of the workspace. The server decides, we only read the answer.
 */
export function workspaceAwaitsCard(workspace: WorkspaceResponse): boolean {
	const billing = workspace.settings?.billing as { trial_state?: string } | undefined
	return billing?.trial_state === 'awaiting_card'
}
