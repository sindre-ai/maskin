/**
 * Every Dinero call this integration can make, as data. There is no function that takes a
 * path or a verb: a call is one of the operations below, so a call that books, changes or
 * deletes cannot be written, only added here by someone who reads this comment first.
 *
 * Dinero saves a purchase voucher as a draft that has no effect on the books until a
 * separate book call; that call is deliberately not here.
 */
export const DINERO_API_URL = 'https://api.dinero.dk'

export const DINERO_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type DineroOperation =
	| { op: 'list_organizations' }
	| { op: 'list_purchase_accounts' }
	| { op: 'list_vat_types' }
	| { op: 'list_contacts'; page: number; pageSize: number }
	| { op: 'list_entries'; fromDate: string; toDate: string }
	| { op: 'get_purchase_voucher'; guid: string }
	| { op: 'upload_file'; form: FormData }
	| { op: 'create_purchase_voucher_draft'; body: Record<string, unknown> }

export interface DineroRequest {
	method: 'GET' | 'POST'
	url: string
	/** Present for a call with a body. A FormData sets its own content type. */
	body?: string | FormData
	json?: boolean
}

/** Builds the one request an operation stands for. Pure, so a test can list them all. */
export function buildRequest(organizationId: number, operation: DineroOperation): DineroRequest {
	const org = `${DINERO_API_URL}/v1/${organizationId}`
	switch (operation.op) {
		case 'list_organizations':
			return { method: 'GET', url: `${DINERO_API_URL}/v1.1/organizations` }
		case 'list_purchase_accounts':
			return { method: 'GET', url: `${org}/accounts/purchase` }
		case 'list_vat_types':
			return { method: 'GET', url: `${org}/vatTypes` }
		case 'list_contacts': {
			const q = new URLSearchParams({
				page: String(operation.page),
				pageSize: String(operation.pageSize),
			})
			return { method: 'GET', url: `${DINERO_API_URL}/v2/${organizationId}/contacts?${q}` }
		}
		case 'list_entries': {
			const q = new URLSearchParams({ fromDate: operation.fromDate, toDate: operation.toDate })
			return { method: 'GET', url: `${org}/entries?${q}` }
		}
		case 'get_purchase_voucher':
			return { method: 'GET', url: `${org}/vouchers/purchase/${operation.guid}` }
		case 'upload_file':
			return { method: 'POST', url: `${org}/files`, body: operation.form }
		case 'create_purchase_voucher_draft':
			return {
				method: 'POST',
				url: `${DINERO_API_URL}/v1.2/${organizationId}/vouchers/purchase`,
				body: JSON.stringify(operation.body),
				json: true,
			}
	}
}

export const DINERO_OPERATIONS: readonly DineroOperation['op'][] = [
	'list_organizations',
	'list_purchase_accounts',
	'list_vat_types',
	'list_contacts',
	'list_entries',
	'get_purchase_voucher',
	'upload_file',
	'create_purchase_voucher_draft',
]

// ── Answers, trimmed to what a bookkeeping agent needs ─────────────────────

type Row = Record<string, unknown>

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function trimOrganization(row: unknown) {
	if (!isRow(row)) return null
	return {
		organization_id: num(row.Id),
		name: str(row.Name),
		vat_number: str(row.VatNumber),
		country: str(row.CountryKey),
	}
}

export function trimAccounts(body: unknown) {
	if (!Array.isArray(body)) return null
	return body.filter(isRow).flatMap((a) =>
		a.IsHidden === true
			? []
			: [
					{
						account_number: num(a.AccountNumber),
						name: str(a.Name),
						vat_code: str(a.VatCode),
						category: str(a.CategoryName) ?? str(a.Category),
					},
				],
	)
}

export function trimVatTypes(body: unknown) {
	if (!Array.isArray(body)) return null
	return body
		.filter(isRow)
		.map((v) => ({ vat_code: str(v.VatCode), name: str(v.Name), vat_rate: num(v.VatRate) }))
}

export function trimContacts(body: unknown, page: number, pageSize: number) {
	if (!isRow(body)) return null
	const rows = Array.isArray(body.Collection) ? body.Collection : []
	const pagination = isRow(body.Pagination) ? body.Pagination : {}
	const total = num(pagination.Result)
	return {
		items: rows.filter(isRow).map((c) => ({
			contact_guid: str(c.ContactGuid),
			name: str(c.Name),
			is_creditor: c.IsCreditor === true,
			is_debitor: c.IsDebitor === true,
			country: str(c.CountryKey),
			vat_number: str(c.VatNumber),
		})),
		page,
		has_more: total !== null ? (page + 1) * pageSize < total : rows.length >= pageSize,
	}
}

export const MAX_ENTRY_ROWS = 200

export function trimEntries(body: unknown, skip: number) {
	if (!Array.isArray(body)) return null
	const rows = body.filter(isRow)
	const page = rows.slice(skip, skip + MAX_ENTRY_ROWS)
	return {
		items: page.map((e) => ({
			date: str(e.Date),
			voucher_number: num(e.VoucherNumber),
			voucher_guid: str(e.VoucherGuid),
			voucher_type: str(e.VoucherType),
			account_number: num(e.AccountNumber),
			account_name: str(e.AccountName),
			description: str(e.Description),
			vat_code: str(e.VatCode),
			amount: num(e.Amount),
			contact_guid: str(e.ContactGuid),
			file_guid: str(e.FileGuid),
		})),
		has_more: skip + MAX_ENTRY_ROWS < rows.length,
		next_skip: skip + MAX_ENTRY_ROWS < rows.length ? skip + MAX_ENTRY_ROWS : null,
	}
}

export function trimVoucher(body: unknown) {
	if (!isRow(body)) return null
	const lines = Array.isArray(body.Lines) ? body.Lines.filter(isRow) : []
	const totals = Array.isArray(body.VoucherTotals) ? body.VoucherTotals.filter(isRow) : []
	const status = str(body.Status)
	return {
		voucher_guid: str(body.Guid),
		status,
		// Dinero calls a voucher that is not yet booked "Draft". Anything else is worth a look.
		is_draft: status === 'Draft',
		voucher_number: num(body.VoucherNumber),
		voucher_date: str(body.VoucherDate),
		purchase_type: str(body.PurchaseType),
		currency: str(body.CurrencyKey),
		contact_guid: str(body.ContactGuid),
		file_guid: str(body.FileGuid),
		external_reference: str(body.ExternalReference),
		booked_at: str(body.BookingTime),
		lines: lines.map((l) => ({
			description: str(l.Description),
			account_number: num(l.AccountNumber),
			vat_code: str(l.VatCode),
			amount_excl_vat: num(l.AmountExclVatValue),
			amount_incl_vat: num(l.AmountInclVatValue),
			vat_amount: num(l.VatAmountValue),
		})),
		totals: totals.map((t) => ({ label: str(t.Label), type: str(t.Type), total: num(t.Total) })),
	}
}
