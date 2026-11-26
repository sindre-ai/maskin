import { describe, expect, it } from 'vitest'
import { sniffAttachmentType } from '../../lib/integrations/providers/linkedin-unipile/attachment'

function boxed(brand: string): Uint8Array {
	const bytes = new Uint8Array(32)
	bytes.set([0, 0, 0, 0x20], 0)
	bytes.set(Buffer.from('ftyp'), 4)
	bytes.set(Buffer.from(brand), 8)
	return bytes
}

describe('sniffAttachmentType', () => {
	it('reads an MP4 from its brand, whatever the file is called', () => {
		for (const brand of ['isom', 'mp42', 'avc1', 'M4V ']) {
			expect(sniffAttachmentType(boxed(brand))).toBe('video/mp4')
		}
	})

	it('reads a QuickTime movie', () => {
		expect(sniffAttachmentType(boxed('qt  '))).toBe('video/quicktime')
	})

	it('does not take a photo in the same box format for a video', () => {
		for (const brand of ['heic', 'avif', 'mif1']) {
			expect(sniffAttachmentType(boxed(brand))).toBeNull()
		}
	})

	it('does not take a short or unrelated file for a video', () => {
		expect(sniffAttachmentType(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))).toBeNull()
		expect(sniffAttachmentType(Buffer.from('not a video at all'))).toBeNull()
	})

	it('still reads PDF, PNG and JPEG', () => {
		expect(sniffAttachmentType(Buffer.from('%PDF-1.7'))).toBe('application/pdf')
		expect(sniffAttachmentType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
		expect(
			sniffAttachmentType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
		).toBe('image/png')
	})
})
