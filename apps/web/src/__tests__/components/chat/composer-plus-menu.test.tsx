import { Composer, DEFAULT_COMPOSER_PLACEHOLDER } from '@/components/chat/chat'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@/hooks/use-files', () => ({
	useUploadFile: () => vi.fn(),
}))

vi.mock('@/components/chat/slash-picker', () => ({
	SlashPicker: () => null,
}))

vi.mock('@/lib/analytics', () => ({
	deriveEntryAgentRole: () => 'coach',
	trackSpecialistSummonedManually: () => {},
}))

function renderComposer() {
	return render(
		<Composer
			workspaceId="ws-test"
			onSend={vi.fn().mockResolvedValue(undefined)}
			disabled={false}
			pending={false}
			surface="sheet"
			selection={EMPTY_CHAT_SELECTION}
			onDispatchSelection={vi.fn()}
			onRemoveAgent={vi.fn()}
			onRemoveObject={vi.fn()}
			onRemoveNotification={vi.fn()}
			onRemoveFile={vi.fn()}
		/>,
		{ wrapper: createWorkspaceWrapper() },
	)
}

describe('Composer + menu', () => {
	it('defaults its placeholder to the spec-verbatim chat-composer hint', () => {
		renderComposer()
		expect(screen.getByPlaceholderText(DEFAULT_COMPOSER_PLACEHOLDER)).toBeInTheDocument()
		expect(DEFAULT_COMPOSER_PLACEHOLDER).toBe('Message… / reference or create · @ mention')
	})

	it('opens a single-row menu with only Attach a file', async () => {
		const user = userEvent.setup()
		renderComposer()

		await user.click(screen.getByRole('button', { name: 'Attach a file' }))

		const menuItems = await screen.findAllByRole('menuitem')
		expect(menuItems).toHaveLength(1)
		expect(menuItems[0]).toHaveTextContent('Attach a file')
		expect(menuItems[0]).toHaveTextContent('PDF, image, or doc')

		// The removed aliases must not appear anywhere in the DOM — they were
		// the specific surface founders reported as broken. The `/` and `@`
		// primitives take their place via the composer placeholder.
		expect(screen.queryByText('Reference an object')).not.toBeInTheDocument()
		expect(screen.queryByText('Mention an agent')).not.toBeInTheDocument()
		expect(screen.queryByText('Create an object')).not.toBeInTheDocument()
	})

	it('triggers the hidden file input when Attach a file is chosen', async () => {
		const user = userEvent.setup()
		const { container } = renderComposer()

		const input = container.querySelector<HTMLInputElement>('input[type="file"]')
		if (!input) throw new Error('composer file input not found')
		const clickSpy = vi.spyOn(input, 'click')

		await user.click(screen.getByRole('button', { name: 'Attach a file' }))
		await user.click(await screen.findByRole('menuitem', { name: /Attach a file/ }))

		expect(clickSpy).toHaveBeenCalledTimes(1)
	})
})
