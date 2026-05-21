import { formatSize, readFileAsBase64 } from '@/lib/file-utils'

describe('formatSize', () => {
	it('formats bytes under 1 KB', () => {
		expect(formatSize(0)).toBe('0 B')
		expect(formatSize(512)).toBe('512 B')
		expect(formatSize(1023)).toBe('1023 B')
	})

	it('formats kilobytes', () => {
		expect(formatSize(1024)).toBe('1.0 KB')
		expect(formatSize(1536)).toBe('1.5 KB')
	})

	it('formats megabytes', () => {
		expect(formatSize(1024 * 1024)).toBe('1.0 MB')
		expect(formatSize(5 * 1024 * 1024 + 512 * 1024)).toBe('5.5 MB')
	})
})

describe('readFileAsBase64', () => {
	it('strips the data URI prefix and returns only the base64 payload', async () => {
		const file = new File(['hello world'], 'greeting.txt', { type: 'text/plain' })
		const base64 = await readFileAsBase64(file)
		// "hello world" → aGVsbG8gd29ybGQ=
		expect(base64).toBe('aGVsbG8gd29ybGQ=')
		expect(base64).not.toContain(',')
		expect(base64).not.toContain('data:')
	})
})
