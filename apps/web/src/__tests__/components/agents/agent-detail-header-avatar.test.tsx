import { AgentDetailHeader } from '@/components/agents/agent-detail-header'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const uploadMutate = vi.fn()

vi.mock('@/hooks/use-actors', () => ({
	useUpdateActor: () => ({ mutate: vi.fn(), isPending: false }),
	useUploadActorAvatar: () => ({ mutate: uploadMutate, isPending: false }),
}))

let membersData: { actorId: string; role?: string }[] | undefined

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: () => ({ data: membersData }),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'me' }),
	getApiKey: () => 'ank_test',
}))

const agent = buildActorResponse({ id: 'agent-1', type: 'agent', name: 'Planner' })

function renderHeader(overrides: Partial<typeof agent> = {}) {
	return render(<AgentDetailHeader agent={{ ...agent, ...overrides }} portrait="idle" />, {
		wrapper: createWorkspaceWrapper(),
	})
}

beforeEach(() => {
	uploadMutate.mockReset()
	membersData = [{ actorId: 'me', role: 'admin' }]
})

describe('AgentDetailHeader profile picture', () => {
	it('lets a workspace admin upload a PNG', async () => {
		const user = userEvent.setup()
		const { container } = renderHeader()
		const file = new File([new Uint8Array([1])], 'face.png', { type: 'image/png' })

		expect(screen.getByRole('button', { name: 'Change profile picture for Planner' })).toBeVisible()
		await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file)

		expect(uploadMutate).toHaveBeenCalledWith({ id: 'agent-1', file }, expect.any(Object))
	})

	it('does not send a file that is not a PNG or JPG', async () => {
		const user = userEvent.setup({ applyAccept: false })
		const { container } = renderHeader()
		const file = new File(['<svg/>'], 'face.svg', { type: 'image/svg+xml' })

		await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file)

		await waitFor(() => expect(uploadMutate).not.toHaveBeenCalled())
	})

	it('hides the control from a plain member', () => {
		membersData = [{ actorId: 'me', role: 'member' }]
		renderHeader()

		expect(screen.queryByRole('button', { name: /Change profile picture/ })).toBeNull()
	})

	it('shows the uploaded picture', () => {
		const { container } = renderHeader({ avatar_url: '/api/actors/agent-1/avatar?v=abc' })

		expect(container.querySelector('img')).toHaveAttribute(
			'src',
			'/api/actors/agent-1/avatar?v=abc',
		)
	})
})
