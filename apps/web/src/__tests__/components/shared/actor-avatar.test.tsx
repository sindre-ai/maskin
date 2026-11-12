import {
	ActorAvatar,
	getActorAvatarPaletteClass,
	getActorHue,
	getActorInitials,
	getActorPlateStyle,
} from '@/components/shared/actor-avatar'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorListItem } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const { listActors } = vi.hoisted(() => ({ listActors: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => {
	const original = await importOriginal<typeof import('@/lib/api')>()
	return { ...original, api: { ...original.api, actors: { list: listActors } } }
})

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

	it('skips punctuation so a bracketed qualifier does not leak into the initials', () => {
		expect(getActorInitials('Linker (Sigrid)')).toBe('LS')
	})

	it('ignores a token that is punctuation only', () => {
		expect(getActorInitials('John - Doe')).toBe('JD')
	})

	it('returns ? when the name is punctuation only', () => {
		expect(getActorInitials('---')).toBe('?')
	})

	it('keeps all three letters of a 3-letter all-caps word', () => {
		expect(getActorInitials('CTO')).toBe('CTO')
		expect(getActorInitials('PMM')).toBe('PMM')
		expect(getActorInitials('CPO')).toBe('CPO')
	})

	it('keeps a 2-letter all-caps word at 2 letters', () => {
		expect(getActorInitials('QA')).toBe('QA')
	})

	it('cuts a mixed-case one-word name to 2 letters', () => {
		expect(getActorInitials('Cto')).toBe('CT')
		expect(getActorInitials('cto')).toBe('CT')
		expect(getActorInitials('Forge')).toBe('FO')
	})

	it('cuts an all-caps word longer than 3 letters to 2 letters', () => {
		expect(getActorInitials('NASA')).toBe('NA')
	})

	it('strips punctuation before the acronym check', () => {
		expect(getActorInitials('(CTO)')).toBe('CTO')
		expect(getActorInitials('C.T.O.')).toBe('CTO')
	})

	it('uses the first letter of the first three words for a three-word name', () => {
		expect(getActorInitials('Chief of Staff')).toBe('COS')
	})

	it('stops at three letters for a name with four or more words', () => {
		expect(getActorInitials('Head of Customer Success')).toBe('HOC')
	})

	it('keeps two-word names at 2 letters', () => {
		expect(getActorInitials('Sebastian Krumhausen')).toBe('SK')
		expect(getActorInitials('CTO Agent')).toBe('CA')
	})

	it('does not count a punctuation-only token as a word', () => {
		expect(getActorInitials('Chief - Staff')).toBe('CS')
		expect(getActorInitials('Linker (Sigrid) Lead')).toBe('LSL')
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

describe('getActorHue', () => {
	it('folds every character with h = (h * 31 + code) % 360, as the app does', () => {
		expect(getActorHue('a')).toBe(97)
		expect(getActorHue('ab')).toBe((97 * 31 + 98) % 360)
		expect(getActorHue('Chief of Staff')).toBe(
			[...'Chief of Staff'].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0),
		)
	})

	it('treats a missing or empty seed as "?"', () => {
		expect(getActorHue(undefined)).toBe(getActorHue('?'))
		expect(getActorHue('')).toBe(getActorHue('?'))
	})

	it('stays inside 0..359', () => {
		for (let i = 0; i < 200; i++) {
			const hue = getActorHue(`actor-${i}-${'x'.repeat(i)}`)
			expect(hue).toBeGreaterThanOrEqual(0)
			expect(hue).toBeLessThan(360)
		}
	})
})

describe('getActorPlateStyle', () => {
	it('draws a 135 degree gradient from the hue to the hue plus 38 under a white highlight', () => {
		const hue = getActorHue('a')
		const style = getActorPlateStyle('a')
		expect(style.backgroundImage).toContain('linear-gradient(135deg')
		expect(style.backgroundImage).toContain(`hsl(${hue} 52% 44%)`)
		expect(style.backgroundImage).toContain(`hsl(${hue + 38} 58% 32%)`)
		expect(style.backgroundImage).toContain('rgba(255,255,255,0.18)')
		expect(style.borderRadius).toBe('30%')
		expect(style.color).toBe('#fff')
	})

	it('wraps the second hue past 360', () => {
		// 'ab' folds to 275, so the second stop is 313; find a seed above 322 to wrap.
		const seed = Array.from({ length: 400 }, (_, i) => `s${i}`).find((s) => getActorHue(s) > 322)
		expect(seed).toBeDefined()
		expect(getActorPlateStyle(seed).backgroundImage).toContain(
			`hsl(${(getActorHue(seed) + 38) % 360} 58% 32%)`,
		)
	})
})

describe('ActorAvatar', () => {
	it('renders 2-letter initials for multi-word names', () => {
		render(<ActorAvatar name="Product Marketer" type="human" />)
		expect(screen.getByText('PM')).toBeInTheDocument()
	})

	it('renders all three letters of a short all-caps role name', () => {
		render(<ActorAvatar name="CTO" type="human" />)
		expect(screen.getByText('CTO')).toBeInTheDocument()
	})

	it('sizes the glyph as a share of the plate: 36 percent, 28 percent for three letters', () => {
		const { rerender } = render(<ActorAvatar name="Sebastian Krumhausen" type="human" />)
		expect(screen.getByText('SK').className).toContain('text-[length:36cqw]')
		rerender(<ActorAvatar name="PMM" type="human" size="sm" />)
		expect(screen.getByText('PMM').className).toContain('text-[length:28cqw]')
		rerender(<ActorAvatar name="PMM" type="agent" size="xl" />)
		expect(screen.getByText('PMM').className).toContain('text-[length:28cqw]')
		rerender(<ActorAvatar name="PMM" type="human" tile />)
		expect(screen.getByText('PMM').className).toContain('text-[length:28cqw]')
		expect(screen.getByTitle('PMM').className).toContain('size-[26px]')
	})

	it('draws agents and people the same: rounded square, white letters, gradient, no pictogram', () => {
		const { container, rerender } = render(<ActorAvatar name="Product Marketer" type="agent" />)
		expect(container.querySelector('svg')).toBeNull()
		expect(screen.getByText('PM')).toBeInTheDocument()
		const agent = screen.getByTitle('Product Marketer')
		expect(agent.style.borderRadius).toBe('30%')
		expect(agent.style.color).toBe('rgb(255, 255, 255)')
		expect(agent.style.backgroundImage).toContain('linear-gradient')
		rerender(<ActorAvatar name="Product Marketer" type="human" />)
		const person = screen.getByTitle('Product Marketer')
		expect(person.style.borderRadius).toBe('30%')
		expect(person.style.backgroundImage).toBe(agent.style.backgroundImage)
	})

	it('keeps its look when a caller passes its own radius or fill', () => {
		render(<ActorAvatar name="Alice" type="human" className="rounded-full bg-secondary" />)
		expect(screen.getByTitle('Alice').style.borderRadius).toBe('30%')
	})

	it('shows the same letters for an agent as for a person', () => {
		const { rerender } = render(<ActorAvatar name="CTO" type="agent" />)
		expect(screen.getByText('CTO')).toBeInTheDocument()
		rerender(<ActorAvatar name="Chief of Staff" type="agent" />)
		expect(screen.getByText('COS')).toBeInTheDocument()
		rerender(<ActorAvatar name="Sebastian Krumhausen" type="human" />)
		expect(screen.getByText('SK')).toBeInTheDocument()
	})

	it('draws a status dot on an agent tile only when a status is given', () => {
		const { container, rerender } = render(
			<ActorAvatar name="Dev" type="agent" size="md" status="failed" />,
		)
		expect(container.querySelector('[data-avatar-status="failed"]')).not.toBeNull()
		rerender(<ActorAvatar name="Dev" type="agent" size="md" />)
		expect(container.querySelector('[data-avatar-status]')).toBeNull()
		rerender(<ActorAvatar name="Dev" type="human" size="md" status="working" />)
		expect(container.querySelector('[data-avatar-status]')).toBeNull()
	})

	it('pulses the working dot only when motion is allowed, and keeps failed still', () => {
		const { container, rerender } = render(
			<ActorAvatar name="Dev" type="agent" size="md" status="working" />,
		)
		const working = container.querySelector('[data-avatar-status="working"]')
		expect(working?.className).toContain('motion-safe:animate-pulse')
		expect(working?.className).toContain('bg-success')
		// The animation class is behind motion-safe, so reduced-motion users get a still dot.
		expect(working?.className.split(' ')).not.toContain('animate-pulse')
		rerender(<ActorAvatar name="Dev" type="agent" size="md" status="failed" />)
		const failed = container.querySelector('[data-avatar-status="failed"]')
		expect(failed?.className).toContain('bg-error')
		expect(failed?.className).not.toContain('animate-pulse')
	})

	it('draws no status dot at the 20px size', () => {
		const { container } = render(<ActorAvatar name="Dev" type="agent" size="sm" status="failed" />)
		expect(container.querySelector('[data-avatar-status]')).toBeNull()
	})

	it('renders 2-letter initials for single-word names', () => {
		render(<ActorAvatar name="Sindre" type="human" />)
		expect(screen.getByText('SI')).toBeInTheDocument()
	})

	it('colours by id when there is one, else by name', () => {
		const { rerender } = render(<ActorAvatar name="Alpha" type="agent" id="actor-abc" />)
		const byId = screen.getByTitle('Alpha').style.backgroundImage
		expect(byId).toContain(`hsl(${getActorHue('actor-abc')} 52% 44%)`)
		rerender(<ActorAvatar name="Alpha" type="agent" id="actor-abc" />)
		expect(screen.getByTitle('Alpha').style.backgroundImage).toBe(byId)
		rerender(<ActorAvatar name="Alpha" type="agent" />)
		expect(screen.getByTitle('Alpha').style.backgroundImage).toContain(
			`hsl(${getActorHue('Alpha')} 52% 44%)`,
		)
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

	it('anchors the tap target to the right edge so it extends left only', () => {
		render(<ActorAvatar name="Alice" type="human" onClick={() => {}} />)
		const el = screen.getByTitle('Alice')
		expect(el.className).toMatch(/after:right-0/)
		// Vertical centring stays; the horizontal centring (left-1/2 + x-translate) is gone,
		// because a centred 44px box overflows the button's right edge.
		expect(el.className).toMatch(/after:top-1\/2/)
		expect(el.className).toMatch(/after:-translate-y-1\/2/)
		expect(el.className).not.toMatch(/after:left-1\/2/)
		expect(el.className).not.toMatch(/after:-translate-x-1\/2/)
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

	describe('working ring (D2)', () => {
		it('renders no wrapper span when `working` is unset', () => {
			const { container } = render(<ActorAvatar name="Alice" type="human" />)
			expect(container.querySelector('.actor-avatar-working-ring')).toBeNull()
		})

		it('wraps the avatar in a `.actor-avatar-working-ring` span when working', () => {
			const { container } = render(<ActorAvatar name="Alice" type="human" working />)
			const ring = container.querySelector('.actor-avatar-working-ring')
			expect(ring).not.toBeNull()
			// The avatar itself keeps its own name; only the wrapper announces
			// the working state — the SPEC's split between "avatar keeps its
			// existing name" and container "aria-label='Agent working…'".
			expect(ring?.getAttribute('aria-label')).toBe('Agent working on this item')
			expect(screen.getByTitle('Alice')).toBeInTheDocument()
		})

		it('wraps the button variant too so a clickable avatar can still show the ring', () => {
			const { container } = render(
				<ActorAvatar name="Alice" type="human" onClick={() => {}} working />,
			)
			const ring = container.querySelector('.actor-avatar-working-ring')
			expect(ring).not.toBeNull()
			expect(ring?.querySelector('button')).not.toBeNull()
		})
	})
})

describe('ActorAvatar picture lookup', () => {
	beforeEach(() => {
		listActors.mockReset()
	})

	it('draws the picture from the workspace actors list when only an id is given', async () => {
		listActors.mockResolvedValue([
			buildActorListItem({ id: 'a-1', name: 'Alice', avatar_url: '/api/actors/a-1/avatar?v=3' }),
		])
		const { container } = render(<ActorAvatar name="Alice" type="human" id="a-1" />, {
			wrapper: createWorkspaceWrapper(),
		})
		await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
		expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/actors/a-1/avatar?v=3')
	})

	it('keeps initials for an actor without a picture', async () => {
		listActors.mockResolvedValue([
			buildActorListItem({ id: 'a-1', name: 'Alice', avatar_url: null }),
		])
		const { container } = render(<ActorAvatar name="Alice" type="human" id="a-1" />, {
			wrapper: createWorkspaceWrapper(),
		})
		await waitFor(() => expect(listActors).toHaveBeenCalled())
		expect(container.querySelector('img')).toBeNull()
		expect(screen.getByText('AL')).toBeInTheDocument()
	})

	it('does not look anything up when the caller passes imageUrl', () => {
		render(
			<ActorAvatar name="Alice" type="human" id="a-1" imageUrl="https://example.com/a.png" />,
			{
				wrapper: createWorkspaceWrapper(),
			},
		)
		expect(listActors).not.toHaveBeenCalled()
	})
})
