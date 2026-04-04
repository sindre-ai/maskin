import { describe, expect, it, vi } from 'vitest'

vi.mock('@ai-native/ext-work/web', () => ({
	default: { name: 'work-web-extension' },
}))

const mockRegisterWebModule = vi.fn()
vi.mock('@ai-native/module-sdk', () => ({
	registerWebModule: mockRegisterWebModule,
}))

describe('extensions', () => {
	it('calls registerWebModule with workWebExtension on import', async () => {
		await import('@/lib/extensions')
		expect(mockRegisterWebModule).toHaveBeenCalledWith({ name: 'work-web-extension' })
	})
})
