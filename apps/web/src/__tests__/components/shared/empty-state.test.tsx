import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EmptyState } from '@/components/shared/empty-state'

describe('EmptyState', () => {
	it('renders title', () => {
		render(<EmptyState title="No items found" />)
		expect(screen.getByText('No items found')).toBeInTheDocument()
	})

	it('renders description when provided', () => {
		render(<EmptyState title="No items" description="Try creating one" />)
		expect(screen.getByText('Try creating one')).toBeInTheDocument()
	})

	it('does not render description when omitted', () => {
		render(<EmptyState title="No items" />)
		expect(screen.queryByText('Try creating one')).not.toBeInTheDocument()
	})

	it('renders action node when provided', () => {
		render(<EmptyState title="No items" action={<button>Create</button>} />)
		expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
	})
})
