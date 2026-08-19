import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRelease = vi.hoisted(() => ({
	current: {
		version: '9.9',
		headline: 'The feed catches you up in one column',
		changes: [
			{ text: 'Cards answer in place.', link: { label: 'See a card', href: '/cards' } },
			{ text: 'The brief reads itself aloud.' },
		],
		note: 'Nothing you configured needs changing.',
	},
}))

vi.mock('@/lib/release-note', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/release-note')>()
	// A getter, so a test can point at a newer note mid-file and the component
	// picks it up on the next render.
	return {
		...actual,
		get CURRENT_RELEASE() {
			return mockRelease.current
		},
	}
})

import { ReleaseCard } from '@/components/foryou/release-card'

describe('ReleaseCard', () => {
	beforeEach(() => localStorage.clear())

	it('announces the version, the headline, its changes and the closing note', () => {
		render(<ReleaseCard />)

		expect(screen.getByText('Update')).toBeInTheDocument()
		expect(screen.getByText('v9.9')).toBeInTheDocument()
		expect(screen.getByText('The feed catches you up in one column')).toBeInTheDocument()
		expect(screen.getByText(/Cards answer in place/)).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'See a card' })).toHaveAttribute('href', '/cards')
		expect(screen.getByText('Nothing you configured needs changing.')).toBeInTheDocument()
	})

	it('stays dismissed per version', async () => {
		const user = userEvent.setup()
		const { unmount } = render(<ReleaseCard />)

		await user.click(screen.getByRole('button', { name: 'Dismiss the release note' }))
		expect(screen.queryByTestId('foryou-release-card')).not.toBeInTheDocument()

		unmount()
		render(<ReleaseCard />)
		expect(screen.queryByTestId('foryou-release-card')).not.toBeInTheDocument()

		// A newer note is a different key, so it surfaces again.
		mockRelease.current = { ...mockRelease.current, version: '10.0' }
		unmount()
		render(<ReleaseCard />)
		expect(screen.getByTestId('foryou-release-card')).toBeInTheDocument()
	})
})
