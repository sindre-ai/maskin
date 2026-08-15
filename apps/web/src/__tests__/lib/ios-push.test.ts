import { initIosPushNotifications } from '@/lib/ios-push'
import { describe, expect, it, vi } from 'vitest'

describe('initIosPushNotifications', () => {
	it('is a no-op in a plain browser (guard short-circuits before the plugin loads)', async () => {
		// In jsdom isTauri() is false, so initIosPushNotifications returns without
		// touching the plugin or dispatching the Rust command. Must not throw.
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		await initIosPushNotifications()
		expect(consoleError).not.toHaveBeenCalled()
		expect(consoleWarn).not.toHaveBeenCalled()
		consoleError.mockRestore()
		consoleWarn.mockRestore()
	})
})
