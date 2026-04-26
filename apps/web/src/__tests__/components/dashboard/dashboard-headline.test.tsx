import { DashboardHeadline } from '@/components/dashboard/dashboard-headline'
import type { HeadlineResponse } from '@maskin/shared'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-dashboard-headline', () => ({
	useDashboardHeadline: vi.fn(),
}))
vi.mock('@/hooks/use-notifications', () => ({
	useNotifications: vi.fn(() => ({ data: [] })),
}))
vi.mock('@/hooks/use-objects', () => ({
	useObjects: vi.fn(() => ({ data: [] })),
}))
vi.mock('@/hooks/use-sessions', () => ({
	useWorkspaceSessions: vi.fn(() => ({ data: [] })),
}))

import { useDashboardHeadline } from '@/hooks/use-dashboard-headline'
import { createWorkspaceWrapper } from '../../setup'

function mockHeadline(headline: HeadlineResponse) {
	vi.mocked(useDashboardHeadline).mockReturnValue({
		headline,
		isLoading: false,
		isError: false,
	})
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('DashboardHeadline', () => {
	it('renders the headline sentence and ambient ticker', () => {
		mockHeadline({
			headline: 'The team is at rest.',
			generatedAt: '2026-04-26T10:00:00.000Z',
			source: 'fallback',
		})
		const Wrapper = createWorkspaceWrapper()

		render(<DashboardHeadline />, { wrapper: Wrapper })

		expect(screen.getByText('The team is at rest.')).toBeInTheDocument()
		expect(screen.getByText(/agents working/)).toBeInTheDocument()
	})

	it('renders the CTA when href is a safe https URL', () => {
		mockHeadline({
			headline: 'One decision is waiting on you.',
			cta: { text: 'Decide now', href: 'https://example.com/decide' },
			generatedAt: '2026-04-26T10:00:00.000Z',
			source: 'llm',
		})
		const Wrapper = createWorkspaceWrapper()

		render(<DashboardHeadline />, { wrapper: Wrapper })

		const link = screen.getByRole('link', { name: /Decide now/ })
		expect(link).toHaveAttribute('href', 'https://example.com/decide')
	})

	it('renders the CTA when href is a same-origin relative path', () => {
		mockHeadline({
			headline: 'One decision is waiting on you.',
			cta: { text: 'Open inbox', href: '/notifications' },
			generatedAt: '2026-04-26T10:00:00.000Z',
			source: 'llm',
		})
		const Wrapper = createWorkspaceWrapper()

		render(<DashboardHeadline />, { wrapper: Wrapper })

		expect(screen.getByRole('link', { name: /Open inbox/ })).toHaveAttribute(
			'href',
			'/notifications',
		)
	})

	it('omits the CTA when href is a javascript: URL', () => {
		mockHeadline({
			headline: 'One decision is waiting on you.',
			cta: { text: 'click me', href: 'javascript:alert(1)' },
			generatedAt: '2026-04-26T10:00:00.000Z',
			source: 'llm',
		})
		const Wrapper = createWorkspaceWrapper()

		render(<DashboardHeadline />, { wrapper: Wrapper })

		expect(screen.queryByRole('link')).not.toBeInTheDocument()
		expect(screen.queryByText('click me')).not.toBeInTheDocument()
	})

	it('omits the CTA when href is a data: URL', () => {
		mockHeadline({
			headline: 'One decision is waiting on you.',
			cta: { text: 'click me', href: 'data:text/html,<script>alert(1)</script>' },
			generatedAt: '2026-04-26T10:00:00.000Z',
			source: 'llm',
		})
		const Wrapper = createWorkspaceWrapper()

		render(<DashboardHeadline />, { wrapper: Wrapper })

		expect(screen.queryByRole('link')).not.toBeInTheDocument()
	})

	it('omits the CTA when href is a protocol-relative URL', () => {
		mockHeadline({
			headline: 'One decision is waiting on you.',
			cta: { text: 'click me', href: '//evil.example.com' },
			generatedAt: '2026-04-26T10:00:00.000Z',
			source: 'llm',
		})
		const Wrapper = createWorkspaceWrapper()

		render(<DashboardHeadline />, { wrapper: Wrapper })

		expect(screen.queryByRole('link')).not.toBeInTheDocument()
	})
})
