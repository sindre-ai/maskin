import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ActorAvatar } from '@/components/shared/actor-avatar'

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
})
