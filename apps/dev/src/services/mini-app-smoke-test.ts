/**
 * Post-regen smoke test for hosted html mini-apps.
 *
 * Between the atomic in-place rewrite (`update_file` on the same file id) and
 * the file being considered "published," the regen agent must prove the new
 * bytes still render and still expose the fresh slot. Willison's invisible
 * sandboxed-iframe pattern is the design model: render the html in isolation,
 * let its scripts execute, then poke the resulting DOM. In-container we don't
 * have a browser, so this kernel runs the same idea through JSDOM — a fresh
 * global, script execution enabled, no host-process access. It's the same
 * tooling `apps/web/src/__tests__/components/files/mini-app-contract.test.ts`
 * uses on the seed app; running it on regen output extends the seed's
 * guarantees to every subsequent regenerated version.
 *
 * The kernel is a pure function of `(html, options)` — no I/O, no side
 * effects. Wiring it to storage/HTTP lives in the route.
 */

import { JSDOM, VirtualConsole } from 'jsdom'
import { MASKIN_APP_DATA_WINDOW_KEY, MASKIN_STATE_SLOT_ID } from './mini-app-regen'

export type SmokeCheckName =
	| 'slot_present'
	| 'slot_is_json'
	| 'renders_without_error'
	| 'body_not_empty'
	| 'exposes_window_key'
	| 'expected_ids_present'

export interface SmokeCheck {
	name: SmokeCheckName
	ok: boolean
	detail?: string
}

export interface SmokeReport {
	ok: boolean
	checks: SmokeCheck[]
}

export interface SmokeTestOptions {
	/**
	 * Object ids that MUST appear in the freshly-baked slot. The regen agent
	 * passes the ids it just fetched — if any is missing the write produced a
	 * stale document (old slot preserved by mistake, or a subset written).
	 */
	expectedObjectIds?: string[]
	/** Sandbox base URL for the virtual document. Irrelevant to the assertions. */
	url?: string
}

const SLOT_RE = new RegExp(
	`<script id="${MASKIN_STATE_SLOT_ID}" type="application/json">([\\s\\S]*?)</script>`,
)

function extractSlotText(html: string): string | null {
	const m = html.match(SLOT_RE)
	return m?.[1] ?? null
}

function collectStringIds(value: unknown, out: Set<string>): void {
	if (value === null || value === undefined) return
	if (typeof value !== 'object') return
	if (Array.isArray(value)) {
		for (const v of value) collectStringIds(v, out)
		return
	}
	const record = value as Record<string, unknown>
	const maybeId = record.id
	if (typeof maybeId === 'string' && maybeId.length > 0) out.add(maybeId)
	for (const v of Object.values(record)) collectStringIds(v, out)
}

/**
 * Render `html` in an isolated JSDOM instance and assert the slot contract
 * still holds. Never throws — every failure is a check row in the report.
 */
export function smokeTestMiniApp(html: string, options: SmokeTestOptions = {}): SmokeReport {
	const checks: SmokeCheck[] = []
	const push = (name: SmokeCheckName, ok: boolean, detail?: string) => {
		checks.push(detail === undefined ? { name, ok } : { name, ok, detail })
	}

	const slotText = extractSlotText(html)
	if (slotText === null) {
		push('slot_present', false, `missing <script id="${MASKIN_STATE_SLOT_ID}"> node`)
		return { ok: false, checks }
	}
	push('slot_present', true)

	let parsed: unknown
	try {
		parsed = JSON.parse(slotText)
	} catch (err) {
		push('slot_is_json', false, err instanceof Error ? err.message : String(err))
		return { ok: false, checks }
	}
	push('slot_is_json', true)

	if (options.expectedObjectIds && options.expectedObjectIds.length > 0) {
		const present = new Set<string>()
		collectStringIds(parsed, present)
		const missing = options.expectedObjectIds.filter((id) => !present.has(id))
		push(
			'expected_ids_present',
			missing.length === 0,
			missing.length === 0 ? undefined : `missing ids: ${missing.join(', ')}`,
		)
	}

	const virtualConsole = new VirtualConsole()
	const scriptErrors: string[] = []
	virtualConsole.on('jsdomError', (err: Error) => {
		scriptErrors.push(err.message ?? String(err))
	})

	let dom: JSDOM
	try {
		dom = new JSDOM(html, {
			runScripts: 'dangerously',
			virtualConsole,
			url: options.url ?? 'https://mini-app.local/',
		})
	} catch (err) {
		push('renders_without_error', false, err instanceof Error ? err.message : String(err))
		return { ok: checks.every((c) => c.ok), checks }
	}

	push(
		'renders_without_error',
		scriptErrors.length === 0,
		scriptErrors.length === 0 ? undefined : scriptErrors.join(' | '),
	)

	const body = dom.window.document.body
	const bodyText = (body?.textContent ?? '').trim()
	push(
		'body_not_empty',
		body !== null && (body.children.length > 0 || bodyText.length > 0),
		body === null ? 'no <body>' : undefined,
	)

	const windowKeyValue = (dom.window as unknown as Record<string, unknown>)[
		MASKIN_APP_DATA_WINDOW_KEY
	]
	push(
		'exposes_window_key',
		windowKeyValue !== undefined,
		windowKeyValue === undefined
			? `window.${MASKIN_APP_DATA_WINDOW_KEY} not set after render`
			: undefined,
	)

	try {
		dom.window.close()
	} catch {
		// closing is best-effort; a JSDOM close failure doesn't invalidate the checks
	}

	return { ok: checks.every((c) => c.ok), checks }
}
