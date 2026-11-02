import { TextCommentCompose } from '@/components/files/text-comment-compose'
import type { CommentRequest } from '@maskin/markdown/react/editor'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const request: CommentRequest = {
	anchor: { quote: 'the quoted passage', prefix: 'before ', suffix: ' after' },
	position: { x: 0.25, y: 0.5 },
	getRect: () => ({ left: 100, top: 100, width: 80, height: 18 }),
}

function renderCompose() {
	const onSave = vi.fn()
	const onDiscard = vi.fn()
	render(<TextCommentCompose request={request} onSave={onSave} onDiscard={onDiscard} />)
	return { onSave, onDiscard }
}

describe('TextCommentCompose', () => {
	it('is a dialog named Comment on selected text, with the quote and a focused textarea', () => {
		renderCompose()
		const dialog = screen.getByRole('dialog', { name: 'Comment on selected text' })
		expect(dialog).toHaveTextContent('the quoted passage')
		const textarea = screen.getByPlaceholderText('Add a comment…')
		expect(textarea).toHaveFocus()
	})

	it('keeps Save draft disabled, at 40% opacity, until the textarea has text', () => {
		renderCompose()
		const save = screen.getByRole('button', { name: 'Save draft' })
		expect(save).toBeDisabled()
		expect(save.className).toContain('disabled:opacity-40')
		fireEvent.change(screen.getByPlaceholderText('Add a comment…'), { target: { value: '   ' } })
		expect(save).toBeDisabled()
		fireEvent.change(screen.getByPlaceholderText('Add a comment…'), { target: { value: 'Why?' } })
		expect(save).toBeEnabled()
	})

	it('saves the typed text', () => {
		const { onSave, onDiscard } = renderCompose()
		fireEvent.change(screen.getByPlaceholderText('Add a comment…'), { target: { value: ' Why? ' } })
		fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
		expect(onSave).toHaveBeenCalledWith('Why?')
		expect(onDiscard).not.toHaveBeenCalled()
	})

	it('Discard closes with no draft', () => {
		const { onSave, onDiscard } = renderCompose()
		fireEvent.change(screen.getByPlaceholderText('Add a comment…'), { target: { value: 'Why?' } })
		fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
		expect(onDiscard).toHaveBeenCalledTimes(1)
		expect(onSave).not.toHaveBeenCalled()
	})

	it('Esc closes with no draft', () => {
		const { onSave, onDiscard } = renderCompose()
		fireEvent.keyDown(screen.getByPlaceholderText('Add a comment…'), { key: 'Escape' })
		expect(onDiscard).toHaveBeenCalledTimes(1)
		expect(onSave).not.toHaveBeenCalled()
	})
})

describe('TextCommentCompose — bottom sheet at 640px and below', () => {
	const originalMatchMedia = window.matchMedia
	beforeEach(() => {
		window.matchMedia = ((query: string) => ({
			matches: true,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		})) as unknown as typeof window.matchMedia
	})
	afterEach(() => {
		window.matchMedia = originalMatchMedia
	})

	it('keeps typed text when the user taps outside it', () => {
		const { onDiscard } = renderCompose()
		fireEvent.change(screen.getByPlaceholderText('Add a comment…'), { target: { value: 'Why?' } })
		fireEvent.pointerDown(document.body)
		fireEvent.pointerUp(document.body)
		fireEvent.click(document.body)
		expect(onDiscard).not.toHaveBeenCalled()
		expect(screen.getByPlaceholderText('Add a comment…')).toHaveValue('Why?')
	})

	it('Esc still closes with no draft', () => {
		const { onSave, onDiscard } = renderCompose()
		fireEvent.change(screen.getByPlaceholderText('Add a comment…'), { target: { value: 'Why?' } })
		fireEvent.keyDown(screen.getByPlaceholderText('Add a comment…'), { key: 'Escape' })
		expect(onDiscard).toHaveBeenCalledTimes(1)
		expect(onSave).not.toHaveBeenCalled()
	})
})
