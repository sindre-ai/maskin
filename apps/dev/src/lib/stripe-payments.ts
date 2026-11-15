const STRIPE_API = 'https://api.stripe.com/v1'
const REQUEST_TIMEOUT_MS = 30_000
const PAGE_SIZE = 100
/** Bounds one listing so a runaway account cannot hold a run forever; the rest waits for the next. */
const MAX_PAGES = 50

/**
 * A payment Stripe says was received: a paid invoice or a completed checkout, reduced to what
 * the match and the reading need. `id` is Stripe's own id (in_... or cs_...), the dedupe key.
 */
export interface StripePayment {
	id: string
	kind: 'invoice' | 'checkout'
	/** The paying customer's email, or null when Stripe holds none. */
	email: string | null
	/** Minor units (cents, ore). */
	amount: number
	/** Lowercase ISO code as Stripe returns it, for example dkk. */
	currency: string
	paidAt: Date
}

/** Stripe answered with an error. `code` is Stripe's error code or type when the body carried one. */
export class StripeApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string | null,
		message: string,
	) {
		super(message)
		this.name = 'StripeApiError'
	}
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const fromUnix = (v: unknown): Date | null => {
	const n = num(v)
	return n === null ? null : new Date(n * 1000)
}

async function stripeError(res: Response): Promise<StripeApiError> {
	let code: string | null = null
	let detail = ''
	try {
		const body = (await res.json()) as {
			error?: { code?: unknown; type?: unknown; message?: unknown }
		}
		code = str(body.error?.code) ?? str(body.error?.type)
		detail = str(body.error?.message) ?? ''
	} catch {
		// Not JSON; the status is all there is.
	}
	return new StripeApiError(
		res.status,
		code,
		`Stripe answered ${res.status}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}`,
	)
}

async function getPage(
	apiKey: string,
	path: string,
	params: Record<string, string>,
	fetchFn: typeof fetch,
): Promise<{ data: Record<string, unknown>[]; hasMore: boolean }> {
	const url = new URL(`${STRIPE_API}${path}`)
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
	const res = await fetchFn(url, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
	if (!res.ok) throw await stripeError(res)
	const body = (await res.json()) as { data?: Record<string, unknown>[]; has_more?: boolean }
	return { data: body.data ?? [], hasMore: body.has_more === true }
}

/**
 * Every object at `path` created at or after `since`, newest first as Stripe returns them,
 * following `starting_after`. A failed page throws, so the caller never mistakes a partial
 * list for the full one.
 */
async function listAll(
	apiKey: string,
	path: string,
	since: Date,
	extra: Record<string, string>,
	fetchFn: typeof fetch,
): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = []
	let startingAfter: string | null = null
	for (let page = 0; page < MAX_PAGES; page++) {
		const params: Record<string, string> = {
			...extra,
			'created[gte]': String(Math.floor(since.getTime() / 1000)),
			limit: String(PAGE_SIZE),
		}
		if (startingAfter) params.starting_after = startingAfter
		const { data, hasMore } = await getPage(apiKey, path, params, fetchFn)
		out.push(...data)
		const last = data[data.length - 1]
		startingAfter = str(last?.id)
		if (!hasMore || !startingAfter) return out
	}
	throw new Error(
		`Stripe ${path} has more than ${MAX_PAGES * PAGE_SIZE} rows since ${since.toISOString()}`,
	)
}

/**
 * Whether the key can read what the job reads (invoices and checkout sessions). Returns a
 * plain-words reason when it cannot, or null when it can. Never throws.
 */
export async function checkStripeKeyAccess(
	apiKey: string,
	fetchFn: typeof fetch = fetch,
): Promise<string | null> {
	for (const [path, what] of [
		['/invoices', 'invoices'],
		['/checkout/sessions', 'checkout sessions'],
	] as const) {
		try {
			await getPage(apiKey, path, { limit: '1' }, fetchFn)
		} catch (err) {
			if (err instanceof StripeApiError && (err.status === 401 || err.status === 403)) {
				return `The Stripe key cannot read ${what} (${err.message}). Give it read access to ${what} and the next run will pick it up.`
			}
			return `Stripe could not be reached to check the key on ${what}: ${String(err)}`
		}
	}
	return null
}

/** Paid invoices created at or after `since`. Zero-amount invoices are not payments. */
export async function listPaidInvoices(
	apiKey: string,
	since: Date,
	fetchFn: typeof fetch = fetch,
): Promise<StripePayment[]> {
	const rows = await listAll(apiKey, '/invoices', since, { status: 'paid' }, fetchFn)
	const out: StripePayment[] = []
	for (const raw of rows) {
		const id = str(raw.id)
		const amount = num(raw.amount_paid)
		const currency = str(raw.currency)
		if (!id || !currency || amount === null || amount <= 0) continue
		const transitions = raw.status_transitions as { paid_at?: unknown } | null | undefined
		out.push({
			id,
			kind: 'invoice',
			email: str(raw.customer_email),
			amount,
			currency,
			paidAt: fromUnix(transitions?.paid_at) ?? fromUnix(raw.created) ?? new Date(0),
		})
	}
	return out
}

/**
 * Completed, paid checkout sessions created at or after `since`. A session that produced an
 * invoice is left out: the invoice is the payment, and counting both would pay twice.
 */
export async function listCompletedCheckouts(
	apiKey: string,
	since: Date,
	fetchFn: typeof fetch = fetch,
): Promise<StripePayment[]> {
	const rows = await listAll(apiKey, '/checkout/sessions', since, { status: 'complete' }, fetchFn)
	const out: StripePayment[] = []
	for (const raw of rows) {
		const id = str(raw.id)
		const amount = num(raw.amount_total)
		const currency = str(raw.currency)
		if (!id || !currency || amount === null || amount <= 0) continue
		if (raw.payment_status !== 'paid') continue
		if (str(raw.invoice)) continue
		const details = raw.customer_details as { email?: unknown } | null | undefined
		out.push({
			id,
			kind: 'checkout',
			email: str(details?.email) ?? str(raw.customer_email),
			amount,
			currency,
			paidAt: fromUnix(raw.created) ?? new Date(0),
		})
	}
	return out
}
