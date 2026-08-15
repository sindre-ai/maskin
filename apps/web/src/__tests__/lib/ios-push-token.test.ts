import { initIosPushTokenRegistration } from '@/lib/ios-push-token'
import { describe, expect, it, vi } from 'vitest'

describe('initIosPushTokenRegistration', () => {
	it('is a no-op in a plain browser (guard short-circuits before either Tauri module loads)', async () => {
		// In jsdom isTauri() is false, so the function returns without
		// importing @tauri-apps/api. Must not throw and must not log a
		// spurious error — a spurious log here would drown out real ones
		// on iOS boot.
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
		await initIosPushTokenRegistration()
		expect(consoleError).not.toHaveBeenCalled()
		consoleError.mockRestore()
	})
})
