import { ObjectCard } from '@/components/objects/data-table/object-card'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>agent working</span>,
}))

describe('ObjectCard row-select checkbox (OL7)', () => {
	function renderCard(overrides?: {
		onSelect?: (v: boolean) => void
		onClick?: () => void
		isSelected?: boolean
	}) {
		const object = buildObjectResponse({ title: 'Row A' })
		const onSelect = overrides?.onSelect ?? vi.fn()
		const onClick = overrides?.onClick ?? vi.fn()
		render(
			<ObjectCard
				object={object}
				workspaceId="ws-1"
				actors={[]}
				isSelected={overrides?.isSelected ?? false}
				onSelect={onSelect}
				onClick={onClick}
			/>,
		)
		return { onSelect, onClick }
	}

	it('renders the visible checkbox as the default size-4 glyph (no data-size="touch")', () => {
		renderCard()
		const cb = screen.getByRole('checkbox', { name: 'Select row' })
		expect(cb).toHaveAttribute('data-size', 'sm')
	})

	it('extends the checkbox tap area to 44×44 via an absolute ::before pseudo-element', () => {
		// A future refactor must not silently shrink the hit box: pin the exact
		// utility classes that compile to the pseudo-element tap surface. Every
		// class here is load-bearing — dropping any of them either loses the
		// pseudo entirely (before:content) or shrinks the hit rect (before:h-11 /
		// before:w-11) or breaks the "centred on the glyph, no layout shift"
		// invariant (relative + absolute + left/top + -translate).
		renderCard()
		const cb = screen.getByRole('checkbox', { name: 'Select row' })
		expect(cb.className).toContain('relative')
		expect(cb.className).toContain("before:content-['']")
		expect(cb.className).toContain('before:absolute')
		expect(cb.className).toContain('before:h-11')
		expect(cb.className).toContain('before:w-11')
		expect(cb.className).toContain('before:left-1/2')
		expect(cb.className).toContain('before:top-1/2')
		expect(cb.className).toContain('before:-translate-x-1/2')
		expect(cb.className).toContain('before:-translate-y-1/2')
	})

	it('toggles selection without firing the card-click navigation', async () => {
		const user = userEvent.setup()
		const { onSelect, onClick } = renderCard()
		await user.click(screen.getByRole('checkbox', { name: 'Select row' }))
		expect(onSelect).toHaveBeenCalledWith(true)
		expect(onClick).not.toHaveBeenCalled()
	})
})
