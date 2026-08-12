import { getActorAvatarPaletteClass } from '@/components/shared/actor-avatar'
import { AvatarGroup, type AvatarGroupItem } from '@/components/shared/avatar-group'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

const items: AvatarGroupItem[] = [
	{ id: 'actor-1', name: 'Ada Lovelace', type: 'agent' },
	{ id: 'actor-2', name: 'Grace Hopper', type: 'agent' },
	{ id: 'actor-3', name: 'Linus Torvalds', type: 'human' },
	{ id: 'actor-4', name: 'Margaret Hamilton', type: 'agent' },
	{ id: 'actor-5', name: 'Alan Turing', type: 'human' },
]

describe('AvatarGroup', () => {
	it('renders an avatar for each visible participant', () => {
		render(<AvatarGroup items={items} />)
		expect(screen.getByTitle('Ada Lovelace')).toBeInTheDocument()
		expect(screen.getByTitle('Grace Hopper')).toBeInTheDocument()
	})

	it('colour is driven by AVATAR_PALETTE identity for each avatar', () => {
		const { container } = render(<AvatarGroup items={items} />)
		const avatar = container.querySelector('[title="Ada Lovelace"]')
		const expected = getActorAvatarPaletteClass('actor-1')
		for (const cls of expected.split(' ')) {
			expect(avatar?.className).toContain(cls)
		}
	})

	it('applies uniform rounded-full to every avatar', () => {
		const { container } = render(<AvatarGroup items={items} />)
		const avatar = container.querySelector('[title="Ada Lovelace"]')
		expect(avatar?.className).toContain('rounded-full')
	})

	it('collapses overflow beyond max into a +N chip', () => {
		render(<AvatarGroup items={items} max={3} />)
		expect(screen.getByText('+2')).toBeInTheDocument()
		expect(screen.queryByTitle('Margaret Hamilton')).not.toBeInTheDocument()
	})

	it('hides the overflow chip when showOverflow is false', () => {
		render(<AvatarGroup items={items} max={3} showOverflow={false} />)
		expect(screen.queryByText('+2')).not.toBeInTheDocument()
	})
})
