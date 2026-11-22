import { Composer } from '@/components/chat/chat'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@/hooks/use-files', () => ({ useUploadFile: () => vi.fn() }))
vi.mock('@/lib/file-utils', () => ({ readFileAsBase64: async () => 'AAAA' }))
vi.mock('@/lib/analytics', () => ({
	deriveEntryAgentRole: () => 'coach',
	trackSpecialistSummonedManually: () => {},
}))

function composer(onEditLast?: () => void) {
	return (
		<Composer
			workspaceId="ws-test"
			onSend={vi.fn().mockResolvedValue(undefined)}
			disabled={false}
			pending={false}
			surface="sheet"
			placeholder="Message"
			selection={EMPTY_CHAT_SELECTION}
			onDispatchSelection={vi.fn()}
			onRemoveAgent={vi.fn()}
			onRemoveObject={vi.fn()}
			onRemoveNotification={vi.fn()}
			onRemoveFile={vi.fn()}
			onEditLast={onEditLast}
		/>
	)
}

describe('Composer up arrow', () => {
	beforeEach(() => sessionStorage.clear())

	it('asks to edit the last message when the box is empty', async () => {
		const onEditLast = vi.fn()
		render(composer(onEditLast), { wrapper: createWorkspaceWrapper() })
		await userEvent.type(screen.getByRole('textbox'), '{ArrowUp}')
		expect(onEditLast).toHaveBeenCalledTimes(1)
	})

	it('does nothing special when the box has text', async () => {
		const onEditLast = vi.fn()
		render(composer(onEditLast), { wrapper: createWorkspaceWrapper() })
		await userEvent.type(screen.getByRole('textbox'), 'hi{ArrowUp}')
		expect(onEditLast).not.toHaveBeenCalled()
	})

	it('does nothing special without a handler', async () => {
		render(composer(), { wrapper: createWorkspaceWrapper() })
		await userEvent.type(screen.getByRole('textbox'), '{ArrowUp}')
		expect(screen.getByRole('textbox')).toHaveValue('')
	})
})
