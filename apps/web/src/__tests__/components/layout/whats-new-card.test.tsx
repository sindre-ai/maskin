import { WhatsNewCard } from '@/components/layout/whats-new-card'
import { WHATS_NEW_ENTRIES, WHATS_NEW_STORAGE_KEY } from '@/lib/whats-new'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

const newest = WHATS_NEW_ENTRIES[0]

describe('WhatsNewCard', () => {
	beforeEach(() => {
		localStorage.clear()
	})

	it('renders the newest entry', () => {
		render(<WhatsNewCard />)
		expect(screen.getByRole('region', { name: "What's new" })).toBeInTheDocument()
		expect(screen.getByText(newest?.title ?? '')).toBeInTheDocument()
		expect(screen.getByText(newest?.body ?? '')).toBeInTheDocument()
	})

	it('dismiss hides it and persists across a remount', async () => {
		const user = userEvent.setup()
		const { unmount } = render(<WhatsNewCard />)
		await user.click(screen.getByRole('button', { name: 'Dismiss' }))
		expect(screen.queryByText(newest?.title ?? '')).not.toBeInTheDocument()
		expect(JSON.parse(localStorage.getItem(WHATS_NEW_STORAGE_KEY) ?? '[]')).toContain(newest?.id)
		unmount()
		render(<WhatsNewCard />)
		expect(screen.queryByText(newest?.title ?? '')).not.toBeInTheDocument()
	})

	it('still shows when storage is corrupt', () => {
		localStorage.setItem(WHATS_NEW_STORAGE_KEY, '{oops')
		render(<WhatsNewCard />)
		expect(screen.getByText(newest?.title ?? '')).toBeInTheDocument()
	})
})
