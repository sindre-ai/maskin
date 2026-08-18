import { EmptyState } from '@/components/shared/empty-state'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

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
		render(<EmptyState title="No items" action={<button type="button">Create</button>} />)
		expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
	})

	it('renders an icon above the title when given one', () => {
		render(<EmptyState title="No items" icon={<svg role="img" aria-label="empty" />} />)
		expect(screen.getByRole('img', { name: 'empty' })).toBeInTheDocument()
	})

	// A screen's flagship empty state has to carry the whole screen, so it reads
	// at full contrast rather than as a quiet muted line.
	it('promotes the title to foreground weight at page emphasis', () => {
		render(<EmptyState title="You're caught up" emphasis="page" />)
		expect(screen.getByText("You're caught up").className).toContain('text-foreground')
	})

	it('keeps the quiet muted title inline by default', () => {
		render(<EmptyState title="No items" />)
		expect(screen.getByText('No items').className).toContain('text-muted-foreground')
	})
})
