import { Composer } from '@/components/chat/chat'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@/hooks/use-files', () => ({
	useUploadFile: () => vi.fn(),
}))

vi.mock('@/lib/file-utils', () => ({
	readFileAsBase64: async () => 'AAAA',
}))

vi.mock('@/lib/analytics', () => ({
	deriveEntryAgentRole: () => 'coach',
	trackSpecialistSummonedManually: () => {},
}))

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
	const props = {
		workspaceId: 'ws-test',
		onSend: vi.fn().mockResolvedValue(undefined),
		disabled: false,
		pending: false,
		surface: 'sheet' as const,
		placeholder: 'Message',
		selection: EMPTY_CHAT_SELECTION,
		onDispatchSelection: vi.fn(),
		onRemoveAgent: vi.fn(),
		onRemoveObject: vi.fn(),
		onRemoveNotification: vi.fn(),
		onRemoveFile: vi.fn(),
		...overrides,
	}
	return {
		...render(<Composer {...props} />, { wrapper: createWorkspaceWrapper() }),
		props,
	}
}

describe('Composer `+` menu', () => {
	it('renders exactly one row (Attach a file) with PDF/image/doc sub-copy', async () => {
		const user = userEvent.setup()
		renderComposer()

		await user.click(screen.getByRole('button', { name: 'Add an object, file, or mention' }))

		const menuItems = screen.getAllByRole('menuitem')
		expect(menuItems).toHaveLength(1)
		expect(menuItems[0]).toHaveTextContent(/Attach a file/i)
		expect(menuItems[0]).toHaveTextContent(/PDF, image, or doc/i)
	})

	it('does not render the removed Reference an object / Mention an agent / Create an object labels', async () => {
		const user = userEvent.setup()
		renderComposer()

		await user.click(screen.getByRole('button', { name: 'Add an object, file, or mention' }))

		expect(screen.queryByText(/Reference an object/i)).not.toBeInTheDocument()
		expect(screen.queryByText(/Mention an agent/i)).not.toBeInTheDocument()
		expect(screen.queryByText(/Create an object/i)).not.toBeInTheDocument()
	})

	it('opens the hidden file input when the Attach a file row is selected', async () => {
		const user = userEvent.setup()
		const { container } = renderComposer()
		const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')
		if (!fileInput) throw new Error('composer file input not found')
		const clickSpy = vi.spyOn(fileInput, 'click')

		await user.click(screen.getByRole('button', { name: 'Add an object, file, or mention' }))
		await user.click(screen.getByRole('menuitem', { name: /Attach a file/i }))

		expect(clickSpy).toHaveBeenCalledTimes(1)
	})
})
