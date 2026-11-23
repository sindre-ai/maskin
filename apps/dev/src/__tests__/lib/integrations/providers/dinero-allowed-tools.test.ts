import { describe, expect, it } from 'vitest'
import {
	DINERO_DRAFT_ONLY_TOOLS,
	DINERO_WITH_BOOKING_TOOLS,
	fixedAllowedTools,
} from '../../../../lib/integrations/providers/dinero/allowed-tools'

describe('Dinero allowed tools', () => {
	it('is the 16 names the accounting flow listing promises', () => {
		expect(DINERO_DRAFT_ONLY_TOOLS).toHaveLength(16)
		expect(DINERO_DRAFT_ONLY_TOOLS).toContain('CreatePurchaseVoucher')
		expect(new Set(DINERO_DRAFT_ONLY_TOOLS).size).toBe(16)
	})

	it('never lists a tool that books, changes or deletes, except BookVoucher behind the switch', () => {
		for (const tool of [
			'BookVoucher',
			'CreateFinanceVoucher',
			'book_finance_voucher',
			'attach_file_to_voucher_card',
			'submit_feedback',
		]) {
			expect(DINERO_DRAFT_ONLY_TOOLS).not.toContain(tool)
		}
		expect(
			DINERO_DRAFT_ONLY_TOOLS.filter((t) => /^(create_|update_|delete_|add_|send_)/.test(t)),
		).toEqual([])
		expect(DINERO_WITH_BOOKING_TOOLS).toEqual([...DINERO_DRAFT_ONLY_TOOLS, 'BookVoucher'])
		expect(DINERO_WITH_BOOKING_TOOLS).not.toContain('CreateFinanceVoucher')
		expect(DINERO_WITH_BOOKING_TOOLS).not.toContain('book_finance_voucher')
	})

	it('picks the list from the booking switch, and has none for another provider', () => {
		expect(fixedAllowedTools('dinero', null)).toBe(DINERO_DRAFT_ONLY_TOOLS)
		expect(fixedAllowedTools('dinero', {})).toBe(DINERO_DRAFT_ONLY_TOOLS)
		expect(fixedAllowedTools('dinero', { dinero_booking: false })).toBe(DINERO_DRAFT_ONLY_TOOLS)
		expect(fixedAllowedTools('dinero', { dinero_booking: 'yes' as unknown as boolean })).toBe(
			DINERO_DRAFT_ONLY_TOOLS,
		)
		expect(fixedAllowedTools('dinero', { dinero_booking: true })).toBe(DINERO_WITH_BOOKING_TOOLS)
		expect(fixedAllowedTools('linear', { dinero_booking: true })).toBeUndefined()
	})
})
