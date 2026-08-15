import { initIosPushDeepLink } from '@/lib/ios-push-deep-link'
import { describe, expect, it, vi } from 'vitest'

describe('initIosPushDeepLink', () => {
	it('is a no-op in a plain browser (guard short-circuits before any Tauri module loads)', async () => {
		// In jsdom isTauri() is false — the function must return without
		// dispatching the Rust command or attaching a visibility listener.
		// Also must not throw or log any error.
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
		const addListener = vi.spyOn(document, 'addEventListener')

		await initIosPushDeepLink()

		expect(consoleError).not.toHaveBeenCalled()
		expect(addListener.mock.calls.some(([evt]) => evt === 'visibilitychange')).toBe(false)

		consoleError.mockRestore()
		addListener.mockRestore()
	})
})
