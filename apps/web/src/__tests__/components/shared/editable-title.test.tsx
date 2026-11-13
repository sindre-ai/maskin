import { EditableTitle } from '@/components/shared/editable-title'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

function open(onChange = vi.fn()) {
	render(<EditableTitle value="Old" entityId="a" onChange={onChange} ariaLabel="Title" />)
	fireEvent.click(screen.getByRole('heading', { name: 'Old' }))
	return { onChange, field: screen.getByLabelText('Title') as HTMLInputElement }
}

describe('EditableTitle focus', () => {
	it('returns focus to the heading after Enter commits', () => {
		const { onChange, field } = open()
		fireEvent.change(field, { target: { value: 'New' } })
		fireEvent.keyDown(field, { key: 'Enter' })
		expect(onChange).toHaveBeenCalledWith('New')
		expect(screen.getByRole('heading')).toHaveFocus()
	})

	it('returns focus to the heading after Escape', () => {
		const { field } = open()
		fireEvent.keyDown(field, { key: 'Escape' })
		expect(screen.getByRole('heading', { name: 'Old' })).toHaveFocus()
	})

	it('does not commit on Enter during IME composition', () => {
		const { onChange, field } = open()
		fireEvent.change(field, { target: { value: 'New' } })
		fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
		expect(onChange).not.toHaveBeenCalled()
		expect(screen.getByLabelText('Title')).toBeInTheDocument()
	})

	it('does not steal focus when the field is left by clicking elsewhere', () => {
		const { field } = open()
		fireEvent.blur(field)
		expect(screen.getByRole('heading')).not.toHaveFocus()
	})
})
