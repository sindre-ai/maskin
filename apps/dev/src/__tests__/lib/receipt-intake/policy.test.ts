import { describe, expect, it } from 'vitest'
import {
	authenticationPasses,
	emailAddressFor,
	hashIntakeKey,
	intakeKeyFromHeader,
	mintEmailToken,
	mintIntakeKey,
	monthKey,
	normalizeAllowedSenders,
	parseAddress,
	senderAllowed,
	sniffReceiptType,
	tokenFromRecipients,
} from '../../../lib/receipt-intake/policy'

const PDF = Buffer.from('%PDF-1.4\n1 0 obj')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const HEIC = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])

describe('sniffReceiptType', () => {
	it('knows the four receipt types from the bytes', () => {
		expect(sniffReceiptType(PDF)?.mime).toBe('application/pdf')
		expect(sniffReceiptType(JPEG)?.mime).toBe('image/jpeg')
		expect(sniffReceiptType(PNG)?.mime).toBe('image/png')
		expect(sniffReceiptType(HEIC)?.mime).toBe('image/heic')
	})

	it('refuses everything else, whatever the file name says', () => {
		expect(sniffReceiptType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull()
		expect(sniffReceiptType(Buffer.from('MZ\x90\x00'))).toBeNull()
		expect(sniffReceiptType(Buffer.from('PK\x03\x04'))).toBeNull()
		expect(sniffReceiptType(Buffer.alloc(0))).toBeNull()
		// An ISO box that is not a heic brand (an mp4).
		expect(
			sniffReceiptType(
				Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
			),
		).toBeNull()
	})
})

describe('sender rules', () => {
	it('reads the address out of a From header', () => {
		expect(parseAddress('Ane Owner <Ane@Firm.DK>')).toBe('ane@firm.dk')
		expect(parseAddress('ane@firm.dk')).toBe('ane@firm.dk')
		expect(parseAddress('not an address')).toBeNull()
		expect(parseAddress(undefined)).toBeNull()
	})

	it("allows the owner's own login email when the list is empty", () => {
		expect(senderAllowed('Ane <ane@firm.dk>', [], 'ane@firm.dk')).toBe(true)
		expect(senderAllowed('stranger@evil.example', [], 'ane@firm.dk')).toBe(false)
	})

	it("uses the owner's list instead of the login email once there is one", () => {
		const list = ['bookkeeper@firm.dk']
		expect(senderAllowed('bookkeeper@firm.dk', list, 'ane@firm.dk')).toBe(true)
		expect(senderAllowed('ane@firm.dk', list, 'ane@firm.dk')).toBe(false)
	})

	it('refuses when there is nothing to compare with', () => {
		expect(senderAllowed('a@b.dk', [], null)).toBe(false)
		expect(senderAllowed(undefined, ['a@b.dk'], null)).toBe(false)
	})

	it('cleans a list of allowed senders', () => {
		expect(normalizeAllowedSenders(['A@B.dk', 'a@b.dk', 'nope', ' C <c@d.dk> '])).toEqual([
			'a@b.dk',
			'c@d.dk',
		])
	})
})

describe('authenticationPasses', () => {
	it('needs DMARC to pass', () => {
		expect(authenticationPasses({ spf: 'pass', dkim: 'pass', dmarc: 'pass' })).toBe(true)
	})

	it('fails closed on anything else, including no result at all', () => {
		expect(authenticationPasses({ spf: 'pass', dkim: 'pass', dmarc: 'fail' })).toBe(false)
		expect(authenticationPasses({ spf: 'pass', dkim: 'pass' })).toBe(false)
		expect(authenticationPasses({ dmarc: 'unknown' })).toBe(false)
		expect(authenticationPasses({ dmarc: 'processing_failed' })).toBe(false)
		expect(authenticationPasses(null)).toBe(false)
		expect(authenticationPasses(undefined)).toBe(false)
	})
})

describe('receiving address', () => {
	it('mints a long random part that is not repeated', () => {
		const a = mintEmailToken()
		expect(a).toMatch(/^r-[a-z2-7]{32}$/)
		expect(mintEmailToken()).not.toBe(a)
	})

	it('finds our token among the recipients, on our domain only', () => {
		const token = mintEmailToken()
		const address = emailAddressFor(token, 'Receipts.Example.com')
		expect(
			tokenFromRecipients(['someone@else.dk', `Flow <${address}>`], 'receipts.example.com'),
		).toBe(token)
		expect(tokenFromRecipients([address], 'other.example.com')).toBeNull()
		expect(tokenFromRecipients(['hello@receipts.example.com'], 'receipts.example.com')).toBeNull()
		expect(tokenFromRecipients([], 'receipts.example.com')).toBeNull()
	})
})

describe('command keys', () => {
	it('mints a key whose hash and last four match', () => {
		const { key, hash, last4 } = mintIntakeKey()
		expect(key.startsWith('rck_')).toBe(true)
		expect(hashIntakeKey(key)).toBe(hash)
		expect(key.endsWith(last4)).toBe(true)
	})

	it('reads only our own kind of key out of the header', () => {
		const { key } = mintIntakeKey()
		expect(intakeKeyFromHeader(`Bearer ${key}`)).toBe(key)
		expect(intakeKeyFromHeader('Bearer ank_abcdefghijklmnopqrstuvwxyz0123456789')).toBeNull()
		expect(intakeKeyFromHeader(undefined)).toBeNull()
	})
})

describe('monthKey', () => {
	it('is the UTC year and month', () => {
		expect(monthKey(new Date('2026-11-30T23:59:00Z'))).toBe('2026-11')
	})
})
