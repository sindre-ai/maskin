import { Composer } from '@/components/chat/chat'
import {
	type ChatSelection,
	EMPTY_CHAT_SELECTION,
	chatSelectionReducer,
} from '@/lib/chat-selection'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useReducer } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const actors = vi.hoisted(() => [
	{ id: 'me', name: 'Me', type: 'human', isSystem: false, description: null, email: null },
	{ id: 'a-cto', name: 'CTO', type: 'agent', isSystem: false, description: null, email: null },
])

vi.mock('@/hooks/use-actors', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-actors')>()),
	useActors: () => ({ data: actors }),
}))
vi.mock('@/hooks/use-conversations', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-conversations')>()),
	useConversationsInfinite: () => ({ data: undefined }),
}))
vi.mock('@/hooks/use-files', () => ({ useUploadFile: () => vi.fn() }))
vi.mock('@/lib/file-utils', () => ({ readFileAsBase64: async () => 'AAAA' }))
vi.mock('@/lib/analytics', () => ({
	deriveEntryAgentRole: () => 'coach',
	trackSpecialistSummonedManually: () => {},
	trackChatMentionInserted: () => {},
	trackChatObjectReferenceCreated: () => {},
}))

type Sent = { content: string; mentions: string[] }

/** The composer wired the way a caller wires it: a selection reducer, and a send that reads the
 *  agent ids from the selection. */
function Harness({
	sent,
	draftKey,
	fillRequest,
}: {
	sent: Sent[]
	draftKey?: string
	fillRequest?: { text?: string; nonce: number } | null
}) {
	const [selection, dispatch] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	const latest = (s: ChatSelection) => s.agents
	return (
		<Composer
			workspaceId="ws-1"
			inlineTags
			onSend={async (content) => {
				sent.push({ content, mentions: latest(selection) })
				dispatch({ type: 'clear_all' })
			}}
			disabled={false}
			pending={false}
			surface="sheet"
			placeholder="Message"
			selection={selection}
			onDispatchSelection={dispatch}
			onRemoveAgent={vi.fn()}
			onRemoveObject={vi.fn()}
			onRemoveNotification={vi.fn()}
			onRemoveFile={vi.fn()}
			conversationParticipantIds={['a-cto']}
			textareaLabel="Message this conversation"
			draftKey={draftKey}
			fillRequest={fillRequest}
		/>
	)
}

const box = () => screen.getByRole('textbox', { name: 'Message this conversation' })
const chips = () => Array.from(box().querySelectorAll('[data-tag-id]'))

function caretIn(node: Node, offset: number) {
	const range = document.createRange()
	range.setStart(node, offset)
	range.collapse(true)
	const sel = document.getSelection()
	sel?.removeAllRanges()
	sel?.addRange(range)
}

/** Types at the end of the box the way a keystroke would: edit the DOM, then input. */
function typeAtEnd(text: string) {
	const root = box()
	const last = root.lastChild
	let node: Text
	if (last && last.nodeType === 3) {
		node = last as Text
		node.data += text
	} else {
		node = document.createTextNode(text)
		root.appendChild(node)
	}
	caretIn(node, node.data.length)
	fireEvent.input(root)
}

const send = () => fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

describe('Composer with inline tags', () => {
	let wrapper: ReturnType<typeof createWorkspaceWrapper>
	beforeEach(() => {
		wrapper = createWorkspaceWrapper()
		sessionStorage.clear()
		document.getSelection()?.removeAllRanges()
	})

	it('keeps a picked tag in the sentence and sends its id with the text', async () => {
		const sent: Sent[] = []
		render(<Harness sent={sent} />, { wrapper })
		typeAtEnd('ask @cto')
		await screen.findByRole('option', { name: /CTO/ })
		fireEvent.keyDown(box(), { key: 'Enter' })
		expect(chips()).toHaveLength(1)
		typeAtEnd('to start')
		send()
		await waitFor(() => expect(sent).toHaveLength(1))
		expect(sent[0]).toEqual({ content: 'ask @CTO to start', mentions: ['a-cto'] })
	})

	it('draws no pill row for the tag, before or after sending', async () => {
		const sent: Sent[] = []
		render(<Harness sent={sent} />, { wrapper })
		typeAtEnd('@cto')
		await screen.findByRole('option', { name: /CTO/ })
		fireEvent.keyDown(box(), { key: 'Enter' })
		expect(screen.queryByLabelText('Selected context')).not.toBeInTheDocument()
		typeAtEnd('go')
		send()
		await waitFor(() => expect(sent).toHaveLength(1))
		expect(screen.queryByLabelText('Selected context')).not.toBeInTheDocument()
		// The box is empty again, chip included.
		await waitFor(() => expect(chips()).toHaveLength(0))
		expect(box().textContent).toBe('')
	})

	it('sends no id for an @name that never went through the picker', async () => {
		const sent: Sent[] = []
		render(<Harness sent={sent} />, { wrapper })
		typeAtEnd('ask @CTO ')
		// Closing the picker without picking leaves the name as plain text.
		fireEvent.keyDown(box(), { key: 'Escape' })
		typeAtEnd('to start')
		send()
		await waitFor(() => expect(sent).toHaveLength(1))
		expect(sent[0]).toEqual({ content: 'ask @CTO to start', mentions: [] })
	})

	it('drops the id when the chip is deleted', async () => {
		const sent: Sent[] = []
		render(<Harness sent={sent} />, { wrapper })
		typeAtEnd('@cto')
		await screen.findByRole('option', { name: /CTO/ })
		fireEvent.keyDown(box(), { key: 'Enter' })
		caretIn(chips()[0]?.nextSibling as Text, 0)
		fireEvent.keyDown(box(), { key: 'Backspace' })
		expect(chips()).toHaveLength(0)
		typeAtEnd('hello')
		send()
		await waitFor(() => expect(sent).toHaveLength(1))
		expect(sent[0]?.mentions).toEqual([])
	})

	it('sends on Enter and keeps Shift+Enter for a new line', async () => {
		const sent: Sent[] = []
		render(<Harness sent={sent} />, { wrapper })
		typeAtEnd('one')
		fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
		expect(sent).toHaveLength(0)
		fireEvent.keyDown(box(), { key: 'Enter' })
		await waitFor(() => expect(sent).toHaveLength(1))
		expect(sent[0]?.content).toContain('one')
	})

	it('restores a draft with its chips', async () => {
		sessionStorage.setItem('composer-draft:conv-1', 'ask @CTO to start')
		sessionStorage.setItem(
			'composer-draft:conv-1:tags',
			JSON.stringify([{ id: 'a-cto', label: 'CTO' }]),
		)
		const sent: Sent[] = []
		render(<Harness sent={sent} draftKey="conv-1" />, { wrapper })
		expect(chips().map((c) => c.getAttribute('data-tag-id'))).toEqual(['a-cto'])
		expect(box().textContent).toBe('ask @CTO to start')
		send()
		await waitFor(() => expect(sent).toHaveLength(1))
		expect(sent[0]).toEqual({ content: 'ask @CTO to start', mentions: ['a-cto'] })
	})

	it('stores the chips with the draft while you type', async () => {
		render(<Harness sent={[]} draftKey="conv-2" />, { wrapper })
		typeAtEnd('hi @cto')
		await screen.findByRole('option', { name: /CTO/ })
		fireEvent.keyDown(box(), { key: 'Enter' })
		await waitFor(() =>
			expect(JSON.parse(sessionStorage.getItem('composer-draft:conv-2:tags') ?? '[]')).toEqual([
				{ id: 'a-cto', label: 'CTO' },
			]),
		)
		expect(sessionStorage.getItem('composer-draft:conv-2')).toBe('hi @CTO ')
	})

	it('replaces the box on a fill request', async () => {
		const { rerender } = render(<Harness sent={[]} fillRequest={null} />, { wrapper })
		typeAtEnd('half')
		rerender(<Harness sent={[]} fillRequest={{ text: 'Here is a task: ', nonce: 1 }} />)
		await waitFor(() => expect(box().textContent).toBe('Here is a task: '))
	})
})
