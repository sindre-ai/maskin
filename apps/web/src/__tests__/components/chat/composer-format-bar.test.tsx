import { ComposerFormatBar } from '@/components/chat/composer-format-bar'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

function setup() {
	const props = {
		active: [],
		onToggle: vi.fn(),
		onSetLink: vi.fn(),
		onRemoveLink: vi.fn(),
		linkHref: () => null,
		focusBox: vi.fn(),
	}
	render(
		<>
			<button type="button">before</button>
			<ComposerFormatBar {...props} />
			<button type="button">after</button>
		</>,
	)
	return userEvent.setup()
}

describe('ComposerFormatBar keyboard', () => {
	it('is one tab stop: Tab enters on the first button and the next Tab leaves the row', async () => {
		const user = setup()
		screen.getByText('before').focus()
		await user.tab()
		expect(screen.getByRole('button', { name: 'Bold' })).toHaveFocus()
		await user.tab()
		expect(screen.getByText('after')).toHaveFocus()
	})

	it('moves between buttons with Left, Right, Home and End, through the Link button', async () => {
		const user = setup()
		screen.getByRole('button', { name: 'Bold' }).focus()
		await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
		expect(screen.getByRole('button', { name: 'Link' })).toHaveFocus()
		await user.keyboard('{ArrowRight}')
		expect(screen.getByRole('button', { name: 'Bulleted list' })).toHaveFocus()
		await user.keyboard('{End}')
		expect(screen.getByRole('button', { name: 'Code block' })).toHaveFocus()
		await user.keyboard('{ArrowRight}')
		expect(screen.getByRole('button', { name: 'Bold' })).toHaveFocus()
		await user.keyboard('{ArrowLeft}')
		expect(screen.getByRole('button', { name: 'Code block' })).toHaveFocus()
		await user.keyboard('{Home}')
		expect(screen.getByRole('button', { name: 'Bold' })).toHaveFocus()
	})

	it('returns to the last focused button when Tab comes back into the row', async () => {
		const user = setup()
		screen.getByRole('button', { name: 'Bold' }).focus()
		await user.keyboard('{ArrowRight}{ArrowRight}')
		await user.tab()
		expect(screen.getByText('after')).toHaveFocus()
		await user.tab({ shift: true })
		expect(screen.getByRole('button', { name: 'Strikethrough' })).toHaveFocus()
	})

	it('keeps arrow keys typed in the link field out of the row', async () => {
		const user = setup()
		await user.click(screen.getByRole('button', { name: 'Link' }))
		const field = await screen.findByLabelText('Link address')
		await user.keyboard('{ArrowRight}{ArrowLeft}')
		expect(field).toHaveFocus()
	})
})
