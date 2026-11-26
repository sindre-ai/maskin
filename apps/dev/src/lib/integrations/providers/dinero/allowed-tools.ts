import type { IntegrationConfig } from '../../../types'
import { DINERO_BRIDGE_BOOKING_TOOL_NAMES, DINERO_BRIDGE_DRAFT_TOOL_NAMES } from './bridge'
import { DINERO_APP_TOOL_NAMES } from './vat-check-tool'

/**
 * The only tools an agent may use on Dinero's hosted server (48 tools, read from the live list on
 * 23 Nov 2026), plus the public API tools the gateway answers itself (./bridge.ts). An exact-name
 * list, not name rules: a tool Dinero adds later is refused until someone lists it here.
 * Everything that changes the books for good or reaches a customer but is not on it stays refused
 * for every agent, Read & write included: submit_feedback. BookVoucher, book_finance_voucher, the
 * payments, the trade offer tools and the emails sit behind the owner's booking switch
 * (DINERO_WITH_BOOKING_TOOLS).
 *
 * The list holds only what makes, edits or removes a draft, or reads:
 * - CreatePurchaseVoucher has no argument that books, so naming it is enough: it saves a draft and
 *   BookVoucher is a separate tool. upload_file puts a receipt in the archive, which does not touch
 *   the books, and gives the fileGuid the draft attaches. attach_file_to_voucher_card puts a
 *   receipt on an existing voucher card.
 * - CreateFinanceVoucher is on the list because it is the only way to save a draft on a group or
 *   balance account, but its book argument books in the same call. The name is not enough: the
 *   gateway checks the arguments (dineroCallRefusal in action-log.ts) and refuses it unless book is
 *   false, or the owner's booking switch is on. create_invoice and create_sales_credit_note get a
 *   looser version of the same check (no book or send argument set to anything but false).
 * - The four draft deletes only remove a draft: Dinero refuses a booked document, which is
 *   corrected with a credit note or counter-posting. delete_finance_voucher_draft is the bridge's,
 *   and reads the voucher first because Dinero's own delete of a booked one books an offset entry.
 * - Contacts and products are not part of the books. Nothing here emails or sends to a customer.
 * - get_report reads the Result, Balance or Saldo report for one whole accounting year;
 *   list_posted_entries reads the posted entries for any range inside one year.
 *
 * The listing text (accounting-loop.ts) names the first 16 plus get_report and list_posted_entries,
 * for the custom-server route that has no argument check. Both only read. Everything else after
 * the first 16 must not be added to a custom server's list: several of them (CreateFinanceVoucher,
 * create_invoice, create_sales_credit_note) need the check. list_posted_entries is answered by our
 * gateway (./bridge.ts), so Dinero's own server does not offer it on the custom-server route.
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
	'CreateFinanceVoucher',
	'get_report',
	// Receipts: put a receipt on a voucher card, and find the inbox address receipts are mailed to.
	'attach_file_to_voucher_card',
	'GetInboxEmailAddresses',
	// Sales drafts. create_invoice and create_sales_credit_note are argument-checked like
	// CreateFinanceVoucher (dineroCallRefusal). The PDFs and get_invoice only read.
	'create_invoice',
	'create_sales_credit_note',
	'get_invoice',
	'get_invoice_pdf',
	'get_sales_credit_note_pdf',
	// Contacts and products.
	'create_contact',
	'update_contact',
	'create_product',
	'list_products',
	// Customer and supplier position.
	'get_state_of_account',
	'get_state_of_account_pdf',
	// Cleaning up its own mistakes: each deletes a draft only. Dinero refuses a booked document.
	'delete_invoice_draft',
	'delete_sales_credit_note_draft',
	'delete_purchase_voucher_draft',
	'delete_purchase_credit_note_draft',
	// Public API tools the gateway answers itself (./bridge.ts): a read, a draft edit and a draft delete.
	...DINERO_BRIDGE_DRAFT_TOOL_NAMES,
	// Answered from our own review log, never sent to Dinero: get_vat_report only reads.
	...DINERO_APP_TOOL_NAMES,
]

/**
 * The draft-only list plus what changes the books for good or reaches a customer, for an owner who
 * switched booking on:
 * - BookVoucher, which also books sales credit notes and purchase credit notes, so those need no
 *   tool of their own.
 * - book_finance_voucher, which books a voucher made from a Dinero template (A-skat, ATP) that
 *   BookVoucher refuses, for payroll postings.
 * - The trade offer tools: create_trade_offer, send_trade_offer (emails the customer) and
 *   generate_invoice_from_trade_offer.
 * - The two tools that register a payment, and the four bridge tools that email an invoice or
 *   chase a late one (./bridge.ts).
 * Each tool that acts on an existing document needs the document's current timestamp
 * (dineroCallRefusal in ./action-log.ts), so nothing lands on a version nobody looked at.
 * Dinero has no tool that accepts a bank line's match: a payment tool is how a line gets cleared.
 */
export const DINERO_WITH_BOOKING_TOOLS: readonly string[] = [
	...DINERO_DRAFT_ONLY_TOOLS,
	'BookVoucher',
	'book_finance_voucher',
	'create_trade_offer',
	'send_trade_offer',
	'generate_invoice_from_trade_offer',
	'add_purchase_payment',
	'add_invoice_payment',
	...DINERO_BRIDGE_BOOKING_TOOL_NAMES,
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
