import { describe, expect, it, vi } from 'vitest'

vi.mock('@maskin/ext-work/web', () => ({
	default: { name: 'work-web-extension' },
}))

vi.mock('@maskin/ext-knowledge/web', () => ({
	default: { name: 'knowledge-web-extension' },
}))

const mockRegisterWebModule = vi.fn()
vi.mock('@maskin/module-sdk', () => ({
	registerWebModule: mockRegisterWebModule,
}))

describe('extensions', () => {
	it('registers work and knowledge web extensions on import', async () => {
		await import('@/lib/extensions')
		expect(mockRegisterWebModule).toHaveBeenCalledWith({ name: 'work-web-extension' })
		expect(mockRegisterWebModule).toHaveBeenCalledWith({ name: 'knowledge-web-extension' })
	})
})
