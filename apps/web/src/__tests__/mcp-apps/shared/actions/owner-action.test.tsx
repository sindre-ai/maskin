import { OwnerAction } from '@/mcp-apps/shared/actions'
import { McpAppContext, type McpAppContextValue } from '@/mcp-apps/shared/mcp-app-provider'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

const ACTOR_UUID = '11111111-1111-1111-1111-111111111111'

function makeWrapper(callTool: McpAppContextValue['callTool']) {
	const value: McpAppContextValue = {
		isConnected: true,
		toolResult: null,
		toolHistory: [],
		callTool,
	}
	return ({ children }: { children: ReactNode }) => (
		<McpAppContext.Provider value={value}>{children}</McpAppContext.Provider>
	)
}

const SUCCESS = (id: string) => ({
	content: [
		{
			type: 'text',
			text: JSON.stringify([{ type: 'object', id, success: true, result: { id } }]),
		},
	],
})

describe('OwnerAction', () => {
	it('rejects non-uuid input with inline validation', async () => {
		const callTool = vi.fn()
		render(<OwnerAction objectId="obj-1" currentOwner={null} />, {
			wrapper: makeWrapper(callTool),
		})

		await act(async () => {
			fireEvent.change(screen.getByLabelText('Owner actor ID'), { target: { value: 'not-a-uuid' } })
			fireEvent.click(screen.getByRole('button', { name: 'Assign' }))
		})

		expect(callTool).not.toHaveBeenCalled()
		expect(await screen.findByRole('alert')).toHaveTextContent(/UUID/i)
	})

	it('sends the trimmed UUID to update_objects on submit', async () => {
		const callTool = vi.fn().mockResolvedValue(SUCCESS('obj-1'))
		render(<OwnerAction objectId="obj-1" currentOwner={null} workspaceId="ws-1" />, {
			wrapper: makeWrapper(callTool),
		})

		await act(async () => {
			fireEvent.change(screen.getByLabelText('Owner actor ID'), {
				target: { value: ` ${ACTOR_UUID} ` },
			})
			fireEvent.click(screen.getByRole('button', { name: 'Assign' }))
		})

		await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1))
		expect(callTool).toHaveBeenCalledWith('update_objects', {
			updates: [{ id: 'obj-1', owner: ACTOR_UUID }],
			workspace_id: 'ws-1',
		})
	})

	it('clears the owner via the Clear button', async () => {
		const callTool = vi.fn().mockResolvedValue(SUCCESS('obj-1'))
		render(<OwnerAction objectId="obj-1" currentOwner={ACTOR_UUID} />, {
			wrapper: makeWrapper(callTool),
		})

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
		})

		await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1))
		expect(callTool).toHaveBeenCalledWith('update_objects', {
			updates: [{ id: 'obj-1', owner: null }],
		})
	})
})
