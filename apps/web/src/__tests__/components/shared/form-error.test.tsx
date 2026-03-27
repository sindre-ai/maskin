import { FormError } from '@/components/shared/form-error'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('FormError', () => {
	it('returns null when no error', () => {
		const { container } = render(<FormError />)
		expect(container.innerHTML).toBe('')
	})

	it('renders single error string', () => {
		render(<FormError error="Name is required" />)
		expect(screen.getByText('Name is required')).toBeInTheDocument()
	})

	it('renders multiple error strings', () => {
		render(<FormError error={['Name is required', 'Email is invalid']} />)
		expect(screen.getByText('Name is required')).toBeInTheDocument()
		expect(screen.getByText('Email is invalid')).toBeInTheDocument()
	})
})
