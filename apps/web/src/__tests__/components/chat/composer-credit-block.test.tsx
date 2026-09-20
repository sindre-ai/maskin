import { Composer } from '@/components/chat/chat'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { InsufficientCreditsBlockedError } from '@/lib/insufficient-credits'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@/hooks/use-files', () => ({
	useUploadFile: () => vi.fn(),
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
	trackChatMentionInserted: () => {},
}))

vi.mock('@/hooks/use-actors', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-actors')>('@/hooks/use-actors')
	return { ...actual, useActors: () => ({ data: [] }) }
})
vi.mock('@/hooks/use-conversations', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-conversations')>(
		'@/hooks/use-conversations',
	)
	return { ...actual, useConversationsInfinite: () => ({ data: { pages: [] } }) }
})

const DRAFT = 'Sweep the backlog before standup'

function renderComposer(onSend: (content: string) => Promise<void>) {
	return render(
		<Composer
			workspaceId="ws-test"
			onSend={onSend}
			disabled={false}
			pending={false}
			surface="sheet"
			placeholder="Message Cass"
			textareaLabel="Message Cass"
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

async function typeAndSend() {
	const textarea = screen.getByLabelText('Message Cass')
	fireEvent.change(textarea, { target: { value: DRAFT } })
	fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
	return textarea
}

/**
 * The credit gate's marker error must read to the composer as *not sent*: the
 * draft is preserved for a retry, but the inline "your message is preserved"
 * alert stays quiet because the shared modal owns the presentation. The generic
 * rejection path below proves the suppression is specific to the marker, not a
 * blanket "never show send errors".
 */
describe('Composer send contract under the credit gate', () => {
	it('keeps the draft and stays quiet when onSend throws the credit-block marker', async () => {
		const onSend = vi.fn().mockRejectedValue(new InsufficientCreditsBlockedError())
		renderComposer(onSend)

		const textarea = await typeAndSend()
		await waitFor(() => expect(onSend).toHaveBeenCalledWith(DRAFT))

		expect(textarea).toHaveValue(DRAFT)
		expect(screen.queryByRole('alert')).not.toBeInTheDocument()
	})

	it('still surfaces the inline alert for a plain send failure', async () => {
		const onSend = vi.fn().mockRejectedValue(new Error('Could not start a session'))
		renderComposer(onSend)

		const textarea = await typeAndSend()
		await waitFor(() => expect(onSend).toHaveBeenCalledWith(DRAFT))

		expect(textarea).toHaveValue(DRAFT)
		expect(screen.getByRole('alert')).toHaveTextContent('Could not start a session')
	})

	it('clears the draft only when the send resolves', async () => {
		const onSend = vi.fn().mockResolvedValue(undefined)
		renderComposer(onSend)

		const textarea = await typeAndSend()
		await waitFor(() => expect(textarea).toHaveValue(''))
	})
})
