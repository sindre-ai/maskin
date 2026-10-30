import { EditMessageCard, type EditMessageCardProps } from '@/components/chat/edit-message-card'
import { MESSAGE_MAX_LENGTH } from '@maskin/shared'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const actors = vi.hoisted(() => [
	{ id: 'me', name: 'Me', type: 'human', isSystem: false, description: null, email: null },
	{ id: 'a-cto', name: 'CTO', type: 'agent', isSystem: false, description: null, email: null },
	{
		id: 'a-dev',
		name: 'Developer',
		type: 'agent',
		isSystem: false,
		description: null,
		email: null,
	},
])

vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: actors }) }))
vi.mock('@/hooks/use-conversations', () => ({
	useConversationsInfinite: () => ({ data: undefined }),
}))

const NAMES: Record<string, string> = { 'a-cto': 'CTO', 'a-dev': 'Developer' }

function renderCard(overrides: Partial<EditMessageCardProps> = {}) {
	const props: EditMessageCardProps = {
		workspaceId: 'ws-1',
		conversationParticipantIds: ['a-cto', 'a-dev'],
		selfActorId: 'me',
		content: 'please start',
		mentions: [],
		labelOf: (id) => NAMES[id] ?? null,
		agentName: (id) => NAMES[id] ?? null,
		saving: false,
		failed: false,
		onSave: vi.fn(),
		onCancel: vi.fn(),
		...overrides,
	}
	render(<EditMessageCard {...props} />, { wrapper: TestWrapper })
	return props
}

const box = () => screen.getByRole('textbox', { name: 'Edit message' })

/** Puts the caret at `offset` in the first text node of the box. */
function caretIn(node: Node, offset: number) {
	const range = document.createRange()
	range.setStart(node, offset)
	range.collapse(true)
	const sel = document.getSelection()
	sel?.removeAllRanges()
	sel?.addRange(range)
}

/** Types `text` at the end of the box the way a keystroke would: edit the DOM, then input. */
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

const chips = () => Array.from(box().querySelectorAll('[data-tag-id]'))

describe('EditMessageCard', () => {
	beforeEach(() => {
		document.getSelection()?.removeAllRanges()
	})

	it('opens with the message text, Save disabled until something changes', () => {
		renderCard()
		expect(box()).toHaveTextContent('please start')
		expect(box()).toHaveAttribute('aria-multiline', 'true')
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
		typeAtEnd('!')
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
	})

	it('turns a picked name into a chip inside the sentence, followed by one space', async () => {
		const props = renderCard({ content: 'ask' })
		typeAtEnd(' @dev')
		await screen.findByRole('option', { name: /Developer/ })
		fireEvent.keyDown(box(), { key: 'Enter' })
		expect(chips()).toHaveLength(1)
		expect(chips()[0]).toHaveAttribute('data-tag-id', 'a-dev')
		expect(box().textContent).toBe('ask @Developer ')
		typeAtEnd('to start')
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		expect(props.onSave).toHaveBeenCalledWith({
			text: 'ask @Developer to start',
			ids: ['a-dev'],
		})
	})

	it('removes the whole chip and its id on Backspace right after it', async () => {
		const props = renderCard({ content: 'ask' })
		typeAtEnd(' @cto')
		await screen.findByRole('option', { name: /CTO/ })
		fireEvent.keyDown(box(), { key: 'Enter' })
		// The caret sits just after the single space that follows the chip; step back over it.
		const space = chips()[0]?.nextSibling as Text
		caretIn(space, 0)
		fireEvent.keyDown(box(), { key: 'Backspace' })
		expect(chips()).toHaveLength(0)
		expect(box().textContent).toBe('ask  ')
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		expect(props.onSave).toHaveBeenCalledWith({ text: 'ask  ', ids: [] })
	})

	it('pastes plain text only: a pasted @name is text and adds no id', () => {
		const props = renderCard({ content: 'hi ' })
		const root = box()
		caretIn(root.lastChild as Text, 3)
		fireEvent.paste(root, { clipboardData: { getData: () => '@CTO <b>now</b>' } })
		expect(chips()).toHaveLength(0)
		expect(root.textContent).toBe('hi @CTO <b>now</b>')
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		expect(props.onSave).toHaveBeenCalledWith({ text: 'hi @CTO <b>now</b>', ids: [] })
	})

	it('puts the tags of an old message at the start as chips, and sends them back on save', () => {
		const props = renderCard({ content: 'please start', mentions: ['a-cto'] })
		expect(chips().map((c) => c.getAttribute('data-tag-id'))).toEqual(['a-cto'])
		expect(box().textContent).toBe('@CTO please start')
		typeAtEnd('!')
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		expect(props.onSave).toHaveBeenCalledWith({ text: '@CTO please start!', ids: ['a-cto'] })
	})

	it('names an agent that was tagged during the edit and not before', async () => {
		renderCard({ content: 'ask', mentions: ['a-cto'] })
		expect(screen.queryByText(/will get this when you save/)).not.toBeInTheDocument()
		typeAtEnd(' @dev')
		await screen.findByRole('option', { name: /Developer/ })
		fireEvent.keyDown(box(), { key: 'Enter' })
		expect(screen.getByText('Developer will get this when you save.')).toBeInTheDocument()
		expect(screen.queryByText('CTO will get this when you save.')).not.toBeInTheDocument()
	})

	it('closes the picker on the first Esc and cancels the edit on the second', async () => {
		const props = renderCard({ content: 'ask' })
		typeAtEnd(' @')
		await screen.findByRole('option', { name: /CTO/ })
		fireEvent.keyDown(box(), { key: 'Escape' })
		await waitFor(() => expect(screen.queryByRole('option', { name: /CTO/ })).toBeNull())
		expect(props.onCancel).not.toHaveBeenCalled()
		fireEvent.keyDown(box(), { key: 'Escape' })
		expect(props.onCancel).toHaveBeenCalledTimes(1)
	})

	it('saves on Enter and keeps Shift+Enter for a new line', () => {
		const props = renderCard()
		typeAtEnd('!')
		fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
		expect(props.onSave).not.toHaveBeenCalled()
		expect(box().querySelector('br')).not.toBeNull()
		fireEvent.keyDown(box(), { key: 'Enter' })
		expect(props.onSave).toHaveBeenCalledTimes(1)
	})

	it('does not save on the Enter that confirms an IME candidate', () => {
		const props = renderCard()
		typeAtEnd('!')
		fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
		expect(props.onSave).not.toHaveBeenCalled()
	})

	it('cancels from the Cancel button without saving', () => {
		const props = renderCard()
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
		expect(props.onCancel).toHaveBeenCalledTimes(1)
		expect(props.onSave).not.toHaveBeenCalled()
	})

	it('shows the saving state: input off, Save busy, Cancel disabled', () => {
		renderCard({ saving: true })
		expect(box()).toHaveAttribute('aria-disabled', 'true')
		expect(screen.getByRole('button', { name: /Saving/ })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
	})

	it('shows the error line and keeps the text and chips when a save failed', () => {
		renderCard({ failed: true, content: 'please start', mentions: ['a-dev'] })
		expect(screen.getByRole('alert')).toHaveTextContent(
			"Couldn't save your edit. Your text is still here.",
		)
		expect(box().textContent).toBe('@Developer please start')
		typeAtEnd('!')
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
	})

	it('blocks Save and shows the counter past the limit', () => {
		renderCard({ content: 'a'.repeat(MESSAGE_MAX_LENGTH) })
		typeAtEnd('b')
		expect(
			screen.getByText(`${MESSAGE_MAX_LENGTH + 1} / ${MESSAGE_MAX_LENGTH}`),
		).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
	})

	it('blocks Save on an empty message', () => {
		renderCard({ content: 'x' })
		box().replaceChildren()
		fireEvent.input(box())
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
		expect(screen.getByText('Edit your message')).toBeInTheDocument()
	})
})
