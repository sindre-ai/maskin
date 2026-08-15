import {
	ActorAvatar,
	getActorAvatarPaletteClass,
	getActorInitials,
} from '@/components/shared/actor-avatar'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('getActorInitials', () => {
	it('returns first char of first two words for multi-word names', () => {
		expect(getActorInitials('Product Marketer')).toBe('PM')
	})

	it('returns first two chars for a single word', () => {
		expect(getActorInitials('Sindre')).toBe('SI')
	})

	it('returns single upper char when the whole name is one character', () => {
		expect(getActorInitials('a')).toBe('A')
	})

	it('returns ? for empty or whitespace-only names', () => {
		expect(getActorInitials('')).toBe('?')
		expect(getActorInitials('   ')).toBe('?')
	})

	it('collapses extra whitespace between words', () => {
		expect(getActorInitials('  Ada    Lovelace  ')).toBe('AL')
	})

	it('uppercases lowercase input', () => {
		expect(getActorInitials('alice bob')).toBe('AB')
	})
})

describe('getActorAvatarPaletteClass', () => {
	it('is deterministic for the same seed', () => {
		expect(getActorAvatarPaletteClass('actor-1')).toBe(getActorAvatarPaletteClass('actor-1'))
	})

	it('produces different classes for different seeds (in the general case)', () => {
		// Two arbitrary ids should generally fall in different palette buckets;
		// while not guaranteed, this checks the palette has multiple entries in use.
		const seen = new Set<string>()
		for (let i = 0; i < 50; i++) {
			seen.add(getActorAvatarPaletteClass(`actor-${i}`))
		}
		expect(seen.size).toBeGreaterThan(1)
	})

	it('falls back to a valid palette class when seed is missing', () => {
		expect(getActorAvatarPaletteClass(undefined)).toMatch(/bg-\[var\(--st-/)
	})
})

describe('ActorAvatar', () => {
	it('renders 2-letter initials for multi-word names', () => {
		render(<ActorAvatar name="Product Marketer" type="agent" />)
		expect(screen.getByText('PM')).toBeInTheDocument()
	})

	it('renders 2-letter initials for single-word names', () => {
		render(<ActorAvatar name="Sindre" type="human" />)
		expect(screen.getByText('SI')).toBeInTheDocument()
	})

	it('applies a deterministic palette class keyed off id', () => {
		const { container, rerender } = render(<ActorAvatar name="Alpha" type="agent" id="actor-abc" />)
		const first = container.firstChild as HTMLElement
		const cls = first.className
		rerender(<ActorAvatar name="Alpha" type="agent" id="actor-abc" />)
		const second = container.firstChild as HTMLElement
		expect(second.className).toBe(cls)
		expect(cls).toMatch(/bg-\[var\(--st-/)
		expect(cls).toMatch(/text-\[var\(--st-/)
	})

	it('has title attribute with name', () => {
		render(<ActorAvatar name="Alice" type="human" />)
		expect(screen.getByTitle('Alice')).toBeInTheDocument()
	})

	it('defaults to sm size on the visible element', () => {
		render(<ActorAvatar name="Alice" type="human" />)
		const el = screen.getByTitle('Alice')
		expect(el.className).toMatch(/h-5/)
		expect(el.className).toMatch(/w-5/)
	})

	it('renders as span when no onClick provided', () => {
		render(<ActorAvatar name="Alice" type="human" />)
		expect(screen.getByTitle('Alice').tagName).toBe('SPAN')
	})

	it('renders as button when onClick is provided', () => {
		render(<ActorAvatar name="Alice" type="human" onClick={() => {}} />)
		expect(screen.getByTitle('Alice').tagName).toBe('BUTTON')
	})

	it('calls onClick when clicked', async () => {
		const handleClick = vi.fn()
		render(<ActorAvatar name="Alice" type="human" onClick={handleClick} />)
		await userEvent.click(screen.getByTitle('Alice'))
		expect(handleClick).toHaveBeenCalledOnce()
	})

	it('button carries a 44px+ tap target via ::after pseudo utilities', () => {
		render(<ActorAvatar name="Alice" type="human" onClick={() => {}} />)
		const el = screen.getByTitle('Alice')
		expect(el.className).toMatch(/after:min-h-11/)
		expect(el.className).toMatch(/after:min-w-11/)
	})

	it('renders an img when imageUrl is set', () => {
		const { container } = render(
			<ActorAvatar name="Alice" type="human" imageUrl="https://example.com/a.png" />,
		)
		const img = container.querySelector('img')
		expect(img).toBeInTheDocument()
		expect(img?.getAttribute('src')).toBe('https://example.com/a.png')
	})

	it('falls back to initials when the image errors', () => {
		const { container } = render(
			<ActorAvatar name="Alice" type="human" imageUrl="https://example.com/broken.png" />,
		)
		const img = container.querySelector('img') as HTMLImageElement
		expect(img).toBeInTheDocument()
		fireEvent.error(img)
		expect(container.querySelector('img')).toBeNull()
		expect(screen.getByText('AL')).toBeInTheDocument()
	})

	it('always renders initials in the DOM so no broken-image icon flashes', () => {
		// Initials layer is present even when imageUrl is provided — it sits
		// underneath the img so first paint has no logo→initials flicker.
		render(<ActorAvatar name="Alice" type="human" imageUrl="https://example.com/a.png" />)
		expect(screen.getByText('AL')).toBeInTheDocument()
	})
})
