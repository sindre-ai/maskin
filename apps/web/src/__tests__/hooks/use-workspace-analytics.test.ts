import { useWorkspaceAnalytics } from '@/hooks/use-workspace-analytics'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	setWorkspaceGroup: vi.fn(),
	registerWorkspaceProperties: vi.fn(),
	setCapturingEnabled: vi.fn(),
	identifyForWorkspace: vi.fn(() => Promise.resolve()),
	trackAppActive: vi.fn(),
	trackNpsSurveyDue: vi.fn(),
	setFaroUser: vi.fn(),
}))

vi.mock('@/lib/posthog', () => ({
	setWorkspaceGroup: mocks.setWorkspaceGroup,
	registerWorkspaceProperties: mocks.registerWorkspaceProperties,
	setCapturingEnabled: mocks.setCapturingEnabled,
	identifyForWorkspace: mocks.identifyForWorkspace,
}))
vi.mock('@/lib/analytics', () => ({
	trackAppActive: mocks.trackAppActive,
	trackNpsSurveyDue: mocks.trackNpsSurveyDue,
}))
vi.mock('@/lib/faro', () => ({ setFaroUser: mocks.setFaroUser }))
vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'actor-1', type: 'human', name: 'Ada', email: 'ada@example.com' }),
}))

const base = {
	workspaceId: 'ws-1',
	resolved: true,
	isTeam: false,
	internal: false,
	paying: false,
	createdAt: '2026-10-01T00:00:00.000Z',
	shareUsage: true,
	anonymizeWorkspace: false,
}

describe('useWorkspaceAnalytics', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('sends the group, identify and app_active once on first load', async () => {
		renderHook((props) => useWorkspaceAnalytics(props), { initialProps: base })
		await vi.waitFor(() => expect(mocks.trackAppActive).toHaveBeenCalledTimes(1))
		expect(mocks.setWorkspaceGroup).toHaveBeenCalledTimes(1)
		expect(mocks.setWorkspaceGroup).toHaveBeenCalledWith('ws-1', '2026-10-01T00:00:00.000Z')
		expect(mocks.identifyForWorkspace).toHaveBeenCalledTimes(1)
	})

	it('does not re-run when the workspace is replaced with an equal copy', async () => {
		const { rerender } = renderHook((props) => useWorkspaceAnalytics(props), {
			initialProps: base,
		})
		await vi.waitFor(() => expect(mocks.trackAppActive).toHaveBeenCalledTimes(1))

		// A refetch of the workspaces list: same values, fresh object.
		rerender({ ...base })
		rerender({ ...base })

		expect(mocks.setWorkspaceGroup).toHaveBeenCalledTimes(1)
		expect(mocks.identifyForWorkspace).toHaveBeenCalledTimes(1)
		expect(mocks.trackAppActive).toHaveBeenCalledTimes(1)
	})

	it('runs again when the workspace id changes', async () => {
		const { rerender } = renderHook((props) => useWorkspaceAnalytics(props), {
			initialProps: base,
		})
		rerender({ ...base, workspaceId: 'ws-2' })
		expect(mocks.setWorkspaceGroup).toHaveBeenCalledTimes(2)
		expect(mocks.setWorkspaceGroup).toHaveBeenLastCalledWith('ws-2', '2026-10-01T00:00:00.000Z')
	})

	it('runs again when a privacy setting really changes', () => {
		const { rerender } = renderHook((props) => useWorkspaceAnalytics(props), {
			initialProps: base,
		})
		rerender({ ...base, shareUsage: false })
		expect(mocks.setCapturingEnabled).toHaveBeenLastCalledWith(false)
		rerender({ ...base, shareUsage: false, anonymizeWorkspace: true })
		expect(mocks.identifyForWorkspace).toHaveBeenLastCalledWith('actor-1', true, expect.any(Object))
		expect(mocks.setWorkspaceGroup).toHaveBeenCalledTimes(3)
	})

	it('registers internal and paying with the other workspace properties', () => {
		renderHook((props) => useWorkspaceAnalytics(props), {
			initialProps: { ...base, internal: true, paying: true },
		})
		expect(mocks.registerWorkspaceProperties).toHaveBeenCalledWith(
			expect.objectContaining({ workspace_id: 'ws-1', internal: true, paying: true }),
		)
	})

	it('registers again when the workspace becomes paying', () => {
		const { rerender } = renderHook((props) => useWorkspaceAnalytics(props), {
			initialProps: base,
		})
		rerender({ ...base, paying: true })
		expect(mocks.registerWorkspaceProperties).toHaveBeenLastCalledWith(
			expect.objectContaining({ internal: false, paying: true }),
		)
	})

	it('sends nothing until the workspace has resolved', () => {
		renderHook((props) => useWorkspaceAnalytics(props), {
			initialProps: { ...base, resolved: false },
		})
		expect(mocks.setWorkspaceGroup).not.toHaveBeenCalled()
		expect(mocks.identifyForWorkspace).not.toHaveBeenCalled()
	})

	it('starts the recommend question after identify when it is due', async () => {
		renderHook((props) => useWorkspaceAnalytics(props), {
			initialProps: { ...base, npsSurveyDue: true },
		})
		await vi.waitFor(() => expect(mocks.trackNpsSurveyDue).toHaveBeenCalledTimes(1))
		const identifyOrder = mocks.identifyForWorkspace.mock.invocationCallOrder[0]
		const surveyOrder = mocks.trackNpsSurveyDue.mock.invocationCallOrder[0]
		expect(identifyOrder).toBeLessThan(surveyOrder)
	})

	it('does not start the recommend question when it is not due', async () => {
		renderHook((props) => useWorkspaceAnalytics(props), { initialProps: base })
		await vi.waitFor(() => expect(mocks.trackAppActive).toHaveBeenCalledTimes(1))
		expect(mocks.trackNpsSurveyDue).not.toHaveBeenCalled()
	})

	it('does not start the recommend question when the workspace turned usage sharing off', async () => {
		renderHook((props) => useWorkspaceAnalytics(props), {
			initialProps: { ...base, shareUsage: false, npsSurveyDue: true },
		})
		await vi.waitFor(() => expect(mocks.identifyForWorkspace).toHaveBeenCalledTimes(1))
		await Promise.resolve()
		expect(mocks.trackNpsSurveyDue).not.toHaveBeenCalled()
	})

	it('starts the question when the flag arrives late, without sending identify again', async () => {
		const { rerender } = renderHook((props) => useWorkspaceAnalytics(props), {
			initialProps: { ...base, npsSurveyDue: false },
		})
		await vi.waitFor(() => expect(mocks.trackAppActive).toHaveBeenCalledTimes(1))
		rerender({ ...base, npsSurveyDue: true })
		await vi.waitFor(() => expect(mocks.trackNpsSurveyDue).toHaveBeenCalledTimes(1))
		expect(mocks.identifyForWorkspace).toHaveBeenCalledTimes(1)
		expect(mocks.setWorkspaceGroup).toHaveBeenCalledTimes(1)
	})
})
