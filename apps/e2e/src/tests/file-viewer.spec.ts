import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// A deliberately wide, short document. At every ship-gate viewport the fit
// scale is width-limited (1600/1600 is the smallest ratio), so the scaled frame
// occupies only the top slice of the scroll viewport and leaves bare viewer area
// below it. The trusted ctrl+wheel case aims at that bare area — a wheel
// delivered over the iframe's own browsing context never reaches the stage
// listener, so aiming there is what makes the gesture assertion meaningful.
const VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>E2E file viewer</title>
<style>body { margin: 0; }</style>
</head>
<body>
<div id="probe" style="width:1600px;height:400px;background:#eef">zoom target</div>
</body>
</html>`

async function seedViewerFile(api: TestAPI, workspaceId: string) {
	const obj = await api.createObject(workspaceId, {
		type: 'bet',
		title: 'File viewer e2e',
		status: 'signal',
	})
	const file = await api.createFile(workspaceId, {
		name: 'e2e-file-viewer.html',
		mime_type: 'text/html',
		content: VIEWER_HTML,
		encoding: 'utf8',
	})
	// Reach the viewer through the same attachment seam a real file reaches it:
	// an `attached` relationship from a workspace object.
	await api.createRelationship(workspaceId, {
		source_type: 'object',
		source_id: obj.id,
		target_type: 'file',
		target_id: file.id,
		type: 'attached',
	})
	return file
}

// The stage is the only element on the page carrying role="application"; the
// route shells render their own loading/404/error states and share the
// data-viewer-state attribute, so that attribute alone does not identify it.
function stageFor(page: Page, name: string) {
	return page.getByRole('application', { name: `Viewer for ${name}` })
}

async function readPercent(page: Page): Promise<number> {
	const text = await page.locator('[aria-live="polite"]').innerText()
	return Number.parseInt(text, 10)
}

test.describe('File viewer stage — shell, controls, and solid surfaces', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders the stage with reachable zoom controls at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			// createFile persists bytes to S3/SeaweedFS, which the verify-e2e CI job
			// does not provision (postgres only) — same constraint as
			// mini-app-viewer.spec.ts and attached-image-render.spec.ts. Locally
			// against a dev stack with real storage the spec runs end to end.
			test.skip(!!process.env.CI, 'S3/SeaweedFS not available in CI')

			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const file = await seedViewerFile(account.api, account.workspaceId)
			await page.goto(`/${account.workspaceId}/files/${file.id}`)

			const stage = stageFor(page, file.name)
			await expect(stage).toBeVisible({ timeout: 10000 })
			// The stage is a keyboard-driven region, not a passive container.
			await expect(stage).toHaveAttribute('tabindex', '0')

			// The html bytes render inside a srcdoc iframe that grants scripts but
			// not same-origin — the isolation contract.
			const preview = page.getByTitle(`Preview of ${file.name}`)
			await expect(preview).toBeVisible({ timeout: 10000 })
			await expect(preview).toHaveAttribute('sandbox', 'allow-scripts')

			// All three controls are visible and genuinely clickable at touch
			// viewports — Playwright's click hit-tests, so a hover-only or
			// pointer-events:none reveal fails here rather than passing on a
			// visibility check alone.
			const zoomIn = page.getByRole('button', { name: 'Zoom in' })
			const zoomOut = page.getByRole('button', { name: 'Zoom out' })
			const fit = page.getByRole('button', { name: 'Fit to screen' })
			await expect(zoomIn).toBeVisible()
			await expect(zoomOut).toBeVisible()
			await expect(fit).toBeVisible()
			await expect(page.locator('[aria-live="polite"]')).toHaveText(/^\d+%$/)

			const before = await readPercent(page)
			await zoomIn.click()
			expect(await readPercent(page)).toBeGreaterThan(before)

			// The zoom overlay is a solid surface with a real shadow — no frosted
			// glass. Asserted on the nearest ancestor that carries a box-shadow,
			// which is the overlay container itself.
			const overlay = await zoomIn.evaluate((el) => {
				let node: HTMLElement | null = el as HTMLElement
				while (node) {
					const s = getComputedStyle(node)
					if (s.boxShadow && s.boxShadow !== 'none') {
						return { bg: s.backgroundColor, backdrop: s.backdropFilter, shadow: s.boxShadow }
					}
					node = node.parentElement
				}
				return null
			})
			expect(overlay).not.toBeNull()
			// rgb(...) is fully opaque; rgba(...) would mean a translucent surface.
			expect(overlay?.bg).toMatch(/^rgb\(/)
			expect(overlay?.backdrop).toBe('none')
			expect(overlay?.shadow).not.toBe('none')

			// The stage's own backdrop is the muted surface, not the browser's
			// black letterbox.
			const stageBg = await stage.evaluate((el) => getComputedStyle(el).backgroundColor)
			expect(stageBg).toMatch(/^rgb\(/)
			expect(stageBg).not.toBe('rgb(0, 0, 0)')
		})
	}
})

test.describe('File viewer stage — zoom interaction', () => {
	test('focuses on mount and responds to keyboard and ctrl+wheel zoom', async ({
		page,
		account,
	}) => {
		test.skip(!!process.env.CI, 'S3/SeaweedFS not available in CI')

		await page.setViewportSize({ width: 1024, height: 768 })

		const file = await seedViewerFile(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/files/${file.id}`)

		const stage = stageFor(page, file.name)
		await expect(stage).toBeVisible({ timeout: 10000 })

		// Keyboard shortcuts are live on arrival with no pointer interaction —
		// the stage takes focus on mount.
		await expect(stage).toBeFocused()

		// NumpadAdd / NumpadSubtract rather than '+' / '-' — Playwright treats a
		// bare '+' in a key chord as its own modifier separator.
		const fitted = await readPercent(page)
		await page.keyboard.press('NumpadAdd')
		await expect.poll(() => readPercent(page)).toBeGreaterThan(fitted)
		const zoomedIn = await readPercent(page)

		await page.keyboard.press('NumpadSubtract')
		await expect.poll(() => readPercent(page)).toBeLessThan(zoomedIn)
		expect(await readPercent(page)).toBe(fitted)

		// '0' returns to fit exactly.
		await page.keyboard.press('NumpadAdd')
		await expect.poll(() => readPercent(page)).toBeGreaterThan(fitted)
		await page.keyboard.press('0')
		await expect.poll(() => readPercent(page)).toBe(fitted)

		// The wheel binding is native and non-passive. React 19 attaches its root
		// wheel listener as passive, which makes preventDefault() a no-op — so the
		// stage binds its own listener. dispatchEvent() returns false only when a
		// listener actually called preventDefault(), which is the observable proof.
		const viewport = previewViewport(page, file.name)
		const notCancelled = await viewport.evaluate((el) => {
			return el.dispatchEvent(
				new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }),
			)
		})
		expect(notCancelled).toBe(false)

		// A plain wheel is not a zoom gesture — the stage early-returns and the
		// browser keeps its native scroll.
		const plainCancelled = await viewport.evaluate((el) => {
			return el.dispatchEvent(
				new WheelEvent('wheel', { deltaY: -120, ctrlKey: false, bubbles: true, cancelable: true }),
			)
		})
		expect(plainCancelled).toBe(true)

		// A trusted ctrl+wheel, aimed below the scaled frame so the event
		// originates in the viewer rather than inside the iframe's browsing
		// context, also zooms — this is the path trackpad pinch and ctrl+wheel
		// take in a real browser.
		const box = await viewport.boundingBox()
		if (!box) throw new Error('viewer viewport has no box')
		await page.mouse.move(box.x + 40, box.y + box.height - 40)
		await page.keyboard.down('Control')
		await page.mouse.wheel(0, -240)
		await page.keyboard.up('Control')
		await expect.poll(() => readPercent(page)).toBeGreaterThan(fitted)
	})

	test('keeps the stage and zoom overlay solid in dark mode', async ({ page, account }) => {
		test.skip(!!process.env.CI, 'S3/SeaweedFS not available in CI')

		await page.setViewportSize({ width: 1024, height: 768 })

		const file = await seedViewerFile(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/files/${file.id}`)

		const stage = stageFor(page, file.name)
		await expect(stage).toBeVisible({ timeout: 10000 })
		const zoomIn = page.getByRole('button', { name: 'Zoom in' })
		await expect(zoomIn).toBeVisible()

		// apps/web themes via a `.dark` class on documentElement
		// (`@custom-variant dark (&:is(.dark *))` in app.css), not
		// prefers-color-scheme — so the class is toggled directly. Emulating the
		// media query would assert nothing.
		await page.evaluate(() => document.documentElement.classList.add('dark'))

		const stageBg = await stage.evaluate((el) => getComputedStyle(el).backgroundColor)
		expect(stageBg).toMatch(/^rgb\(/)
		expect(stageBg).not.toBe('rgb(0, 0, 0)')

		const overlay = await zoomIn.evaluate((el) => {
			let node: HTMLElement | null = el as HTMLElement
			while (node) {
				const s = getComputedStyle(node)
				if (s.boxShadow && s.boxShadow !== 'none') {
					return { bg: s.backgroundColor, backdrop: s.backdropFilter }
				}
				node = node.parentElement
			}
			return null
		})
		expect(overlay).not.toBeNull()
		expect(overlay?.bg).toMatch(/^rgb\(/)
		expect(overlay?.backdrop).toBe('none')
	})
})

// The scroll viewport is the iframe's grandparent: stage > viewport > scaled
// frame > iframe. Walking up from the iframe keeps this independent of the
// Tailwind class names on the wrapper.
function previewViewport(page: Page, name: string) {
	return page.getByTitle(`Preview of ${name}`).locator('xpath=../..')
}
