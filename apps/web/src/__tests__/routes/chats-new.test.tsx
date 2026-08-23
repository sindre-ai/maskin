import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../setup'

const mockCreateConversationMutateAsync = vi.fn()
const mockUploadFile = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => ({
			...options,
			useSearch: () => ({}),
		}),
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'human-1', name: 'You' }),
}))

vi.mock('@/hooks/use-conversations', () => ({
	useCreateConversation: () => ({
		mutateAsync: mockCreateConversationMutateAsync,
		isPending: false,
	}),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({
		data: [{ id: 'agent-1', name: 'Builder', type: 'agent' }],
	}),
}))

vi.mock('@/hooks/use-files', () => ({
	useUploadFile: () => mockUploadFile,
}))

vi.mock('@/lib/file-utils', () => ({
	readFileAsBase64: async () => 'AAAA',
}))

vi.mock('@/components/chat/slash-picker', () => ({
	SlashPicker: () => null,
}))

vi.mock('@/lib/analytics', () => ({
	deriveEntryAgentRole: () => 'coach',
	trackSpecialistSummonedManually: () => {},
}))

import { Route } from '@/routes/_authed/$workspaceId/chats/new'

const NewConversationPage = (Route as unknown as { component: React.FC }).component

function getFileInput(container: HTMLElement): HTMLInputElement {
	const input = container.querySelector<HTMLInputElement>('input[type="file"]')
	if (!input) throw new Error('composer file input not found')
	return input
}

describe('New conversation page — attachments', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockCreateConversationMutateAsync.mockResolvedValue({ id: 'convo-1' })
	})

	it('includes an attached file in initial_message_metadata when starting a new conversation', async () => {
		mockUploadFile.mockResolvedValueOnce({ id: 'file-1' })
		const user = userEvent.setup()
		const { container } = render(<NewConversationPage />, { wrapper: TestWrapper })

		await user.click(screen.getByLabelText('Add people or agents'))
		await user.click(await screen.findByText('Builder'))

		const input = getFileInput(container)
		const pdf = new File(['%PDF-1.4'], 'report.pdf', { type: 'application/pdf' })
		fireEvent.change(input, { target: { files: [pdf] } })
		await waitFor(() => expect(mockUploadFile).toHaveBeenCalledTimes(1))

		await user.type(screen.getByPlaceholderText('Message this conversation'), 'hello')
		await user.click(screen.getByRole('button', { name: 'Send message' }))

		await waitFor(() => expect(mockCreateConversationMutateAsync).toHaveBeenCalledTimes(1))
		const [input1] = mockCreateConversationMutateAsync.mock.calls[0]
		expect(input1.initial_message_metadata.attachments).toEqual([
			expect.objectContaining({
				file_id: 'file-1',
				name: 'report.pdf',
				mime_type: 'application/pdf',
			}),
		])
	})
})
