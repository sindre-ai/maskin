import { ObjectCard } from '@/components/objects/data-table/object-card'
import { api } from '@/lib/api'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>agent working</span>,
}))

vi.mock('@/lib/api', () => ({
	api: {
		objects: {
			star: vi.fn(),
			unstar: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}))

function renderCard(object = buildObjectResponse()) {
	return render(
		<ObjectCard
			object={object}
			workspaceId="ws-1"
			isSelected={false}
			onSelect={() => {}}
			onClick={() => {}}
		/>,
		{ wrapper: TestWrapper },
	)
}

describe('ObjectCard archived variant', () => {
	it('paused rows render at full opacity with no is-archived marker', () => {
		const { container } = renderCard(buildObjectResponse({ status: 'paused' }))
		const row = container.querySelector('[data-archived]')
		expect(row).toBeNull()
		const card = container.firstElementChild as HTMLElement
		expect(card.className).not.toContain('is-archived')
		expect(card.className).not.toContain('opacity-')
	})

	it('archived rows carry the .is-archived variant with 0.62 default and 0.9 hover opacity', () => {
		const { container } = renderCard(buildObjectResponse({ status: 'archived' }))
		const card = container.querySelector('[data-archived]') as HTMLElement
		expect(card).not.toBeNull()
		expect(card.className).toContain('is-archived')
		expect(card.className).toContain('opacity-[0.62]')
		expect(card.className).toContain('hover:opacity-90')
	})

	it('archived rows render "was <prior>" meta when metadata.previous_status is set', () => {
		renderCard(
			buildObjectResponse({ status: 'archived', metadata: { previous_status: 'succeeded' } }),
		)
		expect(screen.getByText('was succeeded')).toBeInTheDocument()
	})

	it('replaces underscores with spaces in the prior status label', () => {
		renderCard(
			buildObjectResponse({ status: 'archived', metadata: { previous_status: 'in_progress' } }),
		)
		expect(screen.getByText('was in progress')).toBeInTheDocument()
	})

	it('omits the "was …" meta when previous_status is missing (avoids "was archived")', () => {
		const { container } = renderCard(buildObjectResponse({ status: 'archived', metadata: null }))
		expect(container.textContent).not.toContain('was ')
	})

	it('does not render the "was …" meta on non-archived rows even if previous_status is set', () => {
		renderCard(
			buildObjectResponse({ status: 'paused', metadata: { previous_status: 'succeeded' } }),
		)
		expect(screen.queryByText('was succeeded')).not.toBeInTheDocument()
	})
})

describe('ObjectCard star toggle', () => {
	it('renders an outline star with aria-pressed=false when the object is not starred', () => {
		renderCard(buildObjectResponse({ isStarred: false }))
		const btn = screen.getByRole('button', { name: 'Star' })
		expect(btn).toHaveAttribute('aria-pressed', 'false')
		expect(btn.querySelector('svg')?.classList.contains('fill-current')).toBe(false)
	})

	it('renders a filled star with aria-pressed=true when the object is starred', () => {
		renderCard(buildObjectResponse({ isStarred: true }))
		const btn = screen.getByRole('button', { name: 'Unstar' })
		expect(btn).toHaveAttribute('aria-pressed', 'true')
		expect(btn.querySelector('svg')?.classList.contains('fill-current')).toBe(true)
	})

	it('treats a missing isStarred field as unstarred', () => {
		renderCard(buildObjectResponse())
		expect(screen.getByRole('button', { name: 'Star' })).toHaveAttribute('aria-pressed', 'false')
	})

	it('optimistically flips to starred on click and calls the star API', async () => {
		vi.mocked(api.objects.star).mockResolvedValue({ starred: true })
		renderCard(buildObjectResponse({ isStarred: false }))
		const btn = screen.getByRole('button', { name: 'Star' })
		fireEvent.click(btn)
		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Unstar' })).toHaveAttribute('aria-pressed', 'true')
		})
		expect(api.objects.star).toHaveBeenCalledWith(expect.any(String))
	})

	it('rolls back to unstarred when the star request fails', async () => {
		vi.mocked(api.objects.star).mockRejectedValue(new Error('network'))
		renderCard(buildObjectResponse({ isStarred: false }))
		const btn = screen.getByRole('button', { name: 'Star' })
		fireEvent.click(btn)
		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Star' })).toHaveAttribute('aria-pressed', 'false')
		})
	})

	it('does not trigger the card onClick when the star is clicked', () => {
		vi.mocked(api.objects.star).mockResolvedValue({ starred: true })
		const onClick = vi.fn()
		render(
			<ObjectCard
				object={buildObjectResponse({ isStarred: false })}
				workspaceId="ws-1"
				isSelected={false}
				onSelect={() => {}}
				onClick={onClick}
			/>,
			{ wrapper: TestWrapper },
		)
		fireEvent.click(screen.getByRole('button', { name: 'Star' }))
		expect(onClick).not.toHaveBeenCalled()
	})
})
