import { ActorAvatar } from '@/components/shared/actor-avatar'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('ActorAvatar', () => {
	it('renders first character of name for human type', () => {
		render(<ActorAvatar name="Alice" type="human" />)
		expect(screen.getByText('A')).toBeInTheDocument()
	})

	it('renders lightning emoji for agent type', () => {
		render(<ActorAvatar name="Bot" type="agent" />)
		expect(screen.getByText('⚡')).toBeInTheDocument()
	})

	it('has title attribute with name', () => {
		render(<ActorAvatar name="Alice" type="human" />)
		expect(screen.getByTitle('Alice')).toBeInTheDocument()
	})

	it('defaults to sm size', () => {
		render(<ActorAvatar name="Alice" type="human" />)
		const el = screen.getByTitle('Alice')
		expect(el.className).toMatch(/h-5/)
		expect(el.className).toMatch(/w-5/)
	})

	it('renders as span when no onClick provided', () => {
		render(<ActorAvatar name="Alice" type="human" />)
		const el = screen.getByTitle('Alice')
		expect(el.tagName).toBe('SPAN')
	})

	it('renders as button when onClick is provided', () => {
		render(<ActorAvatar name="Alice" type="human" onClick={() => {}} />)
		const el = screen.getByTitle('Alice')
		expect(el.tagName).toBe('BUTTON')
	})

	it('calls onClick when button is clicked', async () => {
		const handleClick = vi.fn()
		render(<ActorAvatar name="Alice" type="human" onClick={handleClick} />)
		await userEvent.click(screen.getByTitle('Alice'))
		expect(handleClick).toHaveBeenCalledOnce()
	})
})
