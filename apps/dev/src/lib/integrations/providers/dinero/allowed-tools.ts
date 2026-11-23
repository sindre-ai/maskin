import type { IntegrationConfig } from '../../../types'

/**
 * The only tools an agent may use on Dinero's hosted server (48 tools, read from the live list on
 * 23 Nov 2026). An exact-name list, not name rules: a tool Dinero adds later is refused until
 * someone lists it here. Everything that changes the books but is not on it stays refused for
 * every agent, Read & write included: CreateFinanceVoucher (its book flag books in the same call),
 * book_finance_voucher, the invoice, credit note, trade offer and contact writes, payments, the
 * draft deletes, attach_file_to_voucher_card and submit_feedback.
 *
 * CreatePurchaseVoucher has no argument that books, so naming it is enough: it saves a draft and
 * BookVoucher is a separate tool. upload_file puts a receipt in the archive, which does not touch
 * the books, and gives the fileGuid the draft attaches.
 *
 * The same 16 names are in the accounting flow's listing text (accounting-loop.ts).
 */
export const DINERO_DRAFT_ONLY_TOOLS: readonly string[] = [
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

/** The draft-only list plus BookVoucher, for an owner who switched booking on. */
export const DINERO_WITH_BOOKING_TOOLS: readonly string[] = [
	...DINERO_DRAFT_ONLY_TOOLS,
	'BookVoucher',
]

/**
 * The fixed list of tools for a provider whose server we do not control, or undefined when the
 * provider has none (every other provider is limited by access alone). Dinero's depends on the
 * owner's booking switch, config.dinero_booking, which only our code sets: no route lets an agent
 * write it. Anything but a true value gives the draft-only list.
 */
export function fixedAllowedTools(
	provider: string,
	config: IntegrationConfig | null | undefined,
): readonly string[] | undefined {
	if (provider !== 'dinero') return undefined
	return config?.dinero_booking === true ? DINERO_WITH_BOOKING_TOOLS : DINERO_DRAFT_ONLY_TOOLS
}
