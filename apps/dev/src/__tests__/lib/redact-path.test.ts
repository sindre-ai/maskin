import { describe, expect, it } from 'vitest'
import { redactLogLine, redactPath } from '../../lib/redact-path'

describe('redactPath', () => {
	it('hides a raw APNs token in the devices path', () => {
		const token = 'ab'.repeat(32)
		expect(redactPath(`/api/devices/${token}`)).toBe('/api/devices/:token')
		expect(redactLogLine(`--> DELETE /api/devices/${token} 200 3ms`)).not.toContain(token)
	})

	it('keeps a device uuid and unrelated paths', () => {
		const id = '11111111-1111-4111-8111-111111111111'
		expect(redactPath(`/api/devices/${id}`)).toBe(`/api/devices/${id}`)
		expect(redactPath('/api/objects/abc')).toBe('/api/objects/abc')
		expect(redactPath('/api/devices')).toBe('/api/devices')
	})
})
