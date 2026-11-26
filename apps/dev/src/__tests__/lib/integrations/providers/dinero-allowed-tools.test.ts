import { describe, expect, it } from 'vitest'
import {
	DINERO_DRAFT_ONLY_TOOLS,
	DINERO_WITH_BOOKING_TOOLS,
	fixedAllowedTools,
} from '../../../../lib/integrations/providers/dinero/allowed-tools'

const LISTING_16 = [
	'CreatePurchaseVoucher',
	'list_organizations',
	'list_accounting_years',
	'get_chart_of_accounts',
	'list_purchase_accounts',
	'list_vat_types',
	'list_contacts',
	'get_contact',
	'GetContactByName',
	'list_vouchers',
	'get_purchase_voucher',
	'list_files',
	'list_voucher_file_cards',
	'get_purchase_drafts_for_file',
	'SearchBankTransactions',
	'upload_file',
]

describe('Dinero allowed tools', () => {
	it('starts with the 16 names the accounting flow listing promises, then the rest of the draft tools', () => {
		expect(DINERO_DRAFT_ONLY_TOOLS.slice(0, 16)).toEqual(LISTING_16)
		expect(DINERO_DRAFT_ONLY_TOOLS).toHaveLength(39)
		expect(new Set(DINERO_DRAFT_ONLY_TOOLS).size).toBe(39)
		for (const tool of [
			'CreateFinanceVoucher',
			'get_report',
			'attach_file_to_voucher_card',
			'GetInboxEmailAddresses',
			'create_invoice',
			'create_sales_credit_note',
			'get_invoice',
			'get_invoice_pdf',
			'get_sales_credit_note_pdf',
			'create_contact',
			'update_contact',
			'create_product',
			'list_products',
			'get_state_of_account',
			'delete_invoice_draft',
			'delete_sales_credit_note_draft',
			'delete_purchase_voucher_draft',
			'delete_purchase_credit_note_draft',
			'list_posted_entries',
			'update_purchase_voucher_draft',
			'delete_finance_voucher_draft',
			'get_vat_report',
		]) {
			expect(DINERO_DRAFT_ONLY_TOOLS).toContain(tool)
		}
	})

	it('never lists a tool that books, sends, pays or reaches a customer without the switch', () => {
		for (const tool of [
			'BookVoucher',
			'book_finance_voucher',
			'submit_feedback',
			'create_trade_offer',
			'send_trade_offer',
			'generate_invoice_from_trade_offer',
			'add_purchase_payment',
			'add_invoice_payment',
			'send_invoice_email',
			'add_invoice_reminder',
			'book_invoice_reminder',
			'send_invoice_reminder_email',
		]) {
			expect(DINERO_DRAFT_ONLY_TOOLS).not.toContain(tool)
		}
		expect(DINERO_DRAFT_ONLY_TOOLS.filter((t) => /(^|_)(book|send|add)(_|$)/i.test(t))).toEqual([])
		// Every write it does list makes or removes a draft, or a contact or product.
		expect(
			DINERO_DRAFT_ONLY_TOOLS.filter((t) => /^(create_|update_|delete_|attach_)/.test(t)).sort(),
		).toEqual([
			'attach_file_to_voucher_card',
			'create_contact',
			'create_invoice',
			'create_product',
			'create_sales_credit_note',
			'delete_finance_voucher_draft',
			'delete_invoice_draft',
			'delete_purchase_credit_note_draft',
			'delete_purchase_voucher_draft',
			'delete_sales_credit_note_draft',
			'update_contact',
			'update_purchase_voucher_draft',
		])
		expect(DINERO_WITH_BOOKING_TOOLS).toEqual([
			...DINERO_DRAFT_ONLY_TOOLS,
			'BookVoucher',
			'book_finance_voucher',
			'create_trade_offer',
			'send_trade_offer',
			'generate_invoice_from_trade_offer',
			'add_purchase_payment',
			'add_invoice_payment',
			'send_invoice_email',
			'add_invoice_reminder',
			'book_invoice_reminder',
			'send_invoice_reminder_email',
		])
		// Dinero has no tool that accepts a bank line's match, and none is invented here.
		expect(DINERO_WITH_BOOKING_TOOLS.filter((t) => /match|reconcil/i.test(t))).toEqual([])
		expect(DINERO_WITH_BOOKING_TOOLS).not.toContain('submit_feedback')
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
