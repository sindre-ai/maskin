import { BrowserNotificationsToggle } from '@/components/profile/browser-notifications-row'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const enable = { mutate: vi.fn(), isPending: false }
const disable = { mutate: vi.fn(), isPending: false }
const hook = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))

vi.mock('@/hooks/use-web-push', () => ({ useWebPush: () => hook.value }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { toast } from 'sonner'

function setHook(state: string, isLoading = false) {
	hook.value = { state, isLoading, enable, disable }
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('BrowserNotificationsToggle', () => {
	it('is off and enabled when notifications are available', () => {
		setHook('off')
		render(<BrowserNotificationsToggle />)
		const toggle = screen.getByRole('switch', { name: 'Browser notifications' })
		expect(toggle).not.toBeChecked()
		expect(toggle).toBeEnabled()
	})

	it('is checked when this browser is subscribed', () => {
		setHook('on')
		render(<BrowserNotificationsToggle />)
		expect(screen.getByRole('switch', { name: 'Browser notifications' })).toBeChecked()
	})

	it('is disabled and says so when the browser blocked notifications', () => {
		setHook('blocked')
		render(<BrowserNotificationsToggle />)
		expect(screen.getByRole('switch', { name: 'Browser notifications' })).toBeDisabled()
		expect(screen.getByText('Blocked in site settings')).toBeInTheDocument()
	})

	it('turning it on calls enable, and reports a denied prompt as an error', async () => {
		setHook('off')
		enable.mutate.mockImplementation((_v, opts) => opts.onSuccess('denied'))
		render(<BrowserNotificationsToggle />)
		fireEvent.click(screen.getByRole('switch', { name: 'Browser notifications' }))
		await waitFor(() => expect(enable.mutate).toHaveBeenCalledTimes(1))
		expect(toast.error).toHaveBeenCalled()
		expect(toast.success).not.toHaveBeenCalled()
	})

	it('turning it off calls disable', async () => {
		setHook('on')
		disable.mutate.mockImplementation((_v, opts) => opts.onSuccess())
		render(<BrowserNotificationsToggle />)
		fireEvent.click(screen.getByRole('switch', { name: 'Browser notifications' }))
		await waitFor(() => expect(disable.mutate).toHaveBeenCalledTimes(1))
		expect(toast.success).toHaveBeenCalledWith('Browser notifications are off')
	})

	it('is disabled while a change is in flight', () => {
		setHook('off', true)
		render(<BrowserNotificationsToggle />)
		expect(screen.getByRole('switch', { name: 'Browser notifications' })).toBeDisabled()
	})
})
