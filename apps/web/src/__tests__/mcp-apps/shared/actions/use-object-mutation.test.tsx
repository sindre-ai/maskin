import { useObjectMutation } from '@/mcp-apps/shared/actions'
import { McpAppContext, type McpAppContextValue } from '@/mcp-apps/shared/mcp-app-provider'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

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

const SUCCESS_RESPONSE = (id: string) => ({
	content: [
		{
			type: 'text',
			text: JSON.stringify([{ type: 'object', id, success: true, result: { id } }]),
		},
	],
})

const FAILURE_RESPONSE = (id: string, error = 'permission denied') => ({
	content: [
		{
			type: 'text',
			text: JSON.stringify([{ type: 'object', id, success: false, error }]),
		},
	],
})

describe('useObjectMutation', () => {
	it('exposes optimistic value while the call is in flight and clears on success', async () => {
		let resolveCall: (v: unknown) => void = () => {}
		const callTool = vi.fn().mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCall = resolve
				}),
		)
		const { result } = renderHook(
			() => useObjectMutation<string>({ objectId: 'obj-1', field: 'status', workspaceId: 'ws' }),
			{ wrapper: makeWrapper(callTool) },
		)

		expect(result.current.optimisticValue).toBeNull()

		let outcomePromise: Promise<unknown> = Promise.resolve()
		act(() => {
			outcomePromise = result.current.run('done')
		})
		expect(result.current.optimisticValue).toBe('done')
		expect(result.current.isPending).toBe(true)

		await act(async () => {
			resolveCall(SUCCESS_RESPONSE('obj-1'))
			await outcomePromise
		})

		expect(result.current.optimisticValue).toBeNull()
		expect(result.current.isPending).toBe(false)
		expect(result.current.error).toBeNull()
		expect(callTool).toHaveBeenCalledWith('update_objects', {
			updates: [{ id: 'obj-1', status: 'done' }],
			workspace_id: 'ws',
		})
	})

	it('rolls back optimistic value and surfaces error when the server rejects', async () => {
		const callTool = vi.fn().mockResolvedValue(FAILURE_RESPONSE('obj-2', 'forbidden'))
		const { result } = renderHook(
			() => useObjectMutation<string>({ objectId: 'obj-2', field: 'status' }),
			{ wrapper: makeWrapper(callTool) },
		)

		await act(async () => {
			const outcome = await result.current.run('blocked')
			expect(outcome.success).toBe(false)
			expect(outcome.error).toBe('forbidden')
		})

		expect(result.current.optimisticValue).toBeNull()
		expect(result.current.error).toBe('forbidden')
	})

	it('rolls back when the call rejects', async () => {
		const callTool = vi.fn().mockRejectedValue(new Error('network down'))
		const { result } = renderHook(
			() => useObjectMutation<string>({ objectId: 'obj-3', field: 'status' }),
			{ wrapper: makeWrapper(callTool) },
		)

		await act(async () => {
			const outcome = await result.current.run('done')
			expect(outcome.success).toBe(false)
			expect(outcome.error).toBe('network down')
		})

		expect(result.current.optimisticValue).toBeNull()
		expect(result.current.error).toBe('network down')
	})

	it('passes onSuccess the confirmed value', async () => {
		const callTool = vi.fn().mockResolvedValue(SUCCESS_RESPONSE('obj-4'))
		const onSuccess = vi.fn()
		const { result } = renderHook(
			() =>
				useObjectMutation<string | null>({
					objectId: 'obj-4',
					field: 'driver',
					onSuccess,
				}),
			{ wrapper: makeWrapper(callTool) },
		)

		await act(async () => {
			await result.current.run(null)
		})

		await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(null))
	})

	it('treats unparseable tool responses as a soft failure', async () => {
		// Server returned non-JSON text — we must not silently report success
		// or call onSuccess, otherwise the optimistic UI clears for a write
		// the server may never have made.
		const callTool = vi.fn().mockResolvedValue({
			content: [{ type: 'text', text: 'not-json' }],
		})
		const onSuccess = vi.fn()
		const { result } = renderHook(
			() =>
				useObjectMutation<string>({
					objectId: 'obj-5',
					field: 'status',
					onSuccess,
				}),
			{ wrapper: makeWrapper(callTool) },
		)

		await act(async () => {
			const outcome = await result.current.run('done')
			expect(outcome.success).toBe(false)
		})

		expect(onSuccess).not.toHaveBeenCalled()
		expect(result.current.optimisticValue).toBeNull()
		expect(result.current.error).toBeTruthy()
	})

	it('treats a missing entry for this objectId as a soft failure', async () => {
		// update_objects returned results, but none matched the object we asked
		// to mutate — could mean the server filtered it out (e.g. permissions)
		// or the call was misrouted. Either way we should not claim success.
		const callTool = vi.fn().mockResolvedValue({
			content: [
				{
					type: 'text',
					text: JSON.stringify([{ type: 'object', id: 'other-obj', success: true }]),
				},
			],
		})
		const onSuccess = vi.fn()
		const { result } = renderHook(
			() =>
				useObjectMutation<string>({
					objectId: 'obj-6',
					field: 'status',
					onSuccess,
				}),
			{ wrapper: makeWrapper(callTool) },
		)

		await act(async () => {
			const outcome = await result.current.run('done')
			expect(outcome.success).toBe(false)
		})

		expect(onSuccess).not.toHaveBeenCalled()
		expect(result.current.optimisticValue).toBeNull()
	})
})
