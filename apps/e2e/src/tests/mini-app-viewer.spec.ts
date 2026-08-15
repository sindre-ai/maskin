import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The immutable policy the viewer must inject into every mini-app document.
// This is the literal value of MINI_APP_CSP in apps/web/src/lib/mini-app.ts —
// asserting the exact string is the point: any relaxation (e.g. allowing
// connect-src) must fail this spec.
const PLATFORM_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"

// A mini-app authored the way an agent authors one. It carries its own CSP meta
// (which the viewer must strip so only the platform policy holds) and a
// build-time data slot whose JSON is the app's only content — the render script
// draws everything from window.__MASKIN_APP_DATA__, so the rendered text must
// equal the slot JSON, proving the slot → global → DOM path end to end.
// The JSON deliberately uses no characters needing HTML escaping, so the slot
// node's textContent is byte-identical to the source.
const MINI_APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'">
<title>E2E mini-app</title>
<style>.out { font-family: sans-serif; }</style>
</head>
<body>
<h1 id="heading">placeholder</h1>
<script id="maskin-state" type="application/json">{"app":"e2e-mini-app","objects":["obj-1","obj-2"]}</script>
<script>
  var data = window.__MASKIN_APP_DATA__
  document.getElementById('heading').textContent = data.app + ':' + data.objects.join(',')
</script>
</body>
</html>`

test.describe('Sandboxed iframe mini-app viewer', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders a sandboxed mini-app with platform CSP and data slot at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			// createFile persists bytes to S3/SeaweedFS, which the verify-e2e CI job
			// does not provision (postgres only) — same constraint as
			// attached-image-render.spec.ts. Locally against a dev stack with real
			// storage the spec runs end to end.
			test.skip(!!process.env.CI, 'S3/SeaweedFS not available in CI')

			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const obj = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Mini-app viewer e2e',
				status: 'signal',
			})

			const file = await account.api.createFile(account.workspaceId, {
				name: 'e2e-mini-app.html',
				mime_type: 'text/html',
				content: MINI_APP_HTML,
				encoding: 'utf8',
			})

			// Reach the viewer through the same attachment seam a real mini-app
			// reaches it: an `attached` relationship from a workspace object.
			await account.api.createRelationship(account.workspaceId, {
				source_type: 'object',
				source_id: obj.id,
				target_type: 'file',
				target_id: file.id,
				type: 'attached',
			})

			await page.goto(`/${account.workspaceId}/files/${file.id}`)

			// The html file's bytes render inside a srcdoc iframe whose sandbox
			// grants scripts but not same-origin — the isolation contract, and the
			// reason the sandbox attribute must be exactly "allow-scripts".
			const preview = page.getByTitle(`Preview of ${file.name}`)
			await expect(preview).toBeVisible({ timeout: 10000 })
			await expect(preview).toHaveAttribute('sandbox', 'allow-scripts')

			// The document body is the prepared html: platform CSP meta + data slot
			// injected, the agent's own CSP meta stripped.
			await expect(preview).toHaveAttribute('srcdoc', /id="maskin-state"/)
			await expect(preview).not.toHaveAttribute('srcdoc', /default-src 'self'/)

			// Resolve the srcdoc iframe's Frame (not the FrameLocator) so the
			// assertions below can evaluate in its document.
			const handle = await preview.elementHandle()
			const frame = await handle?.contentFrame()
			if (!frame) throw new Error('mini-app iframe did not attach a document')

			// Rendered output equals the slot JSON — window.__MASKIN_APP_DATA__
			// reached the app and the app drew from it, not a hardcoded copy.
			await expect(frame.locator('#heading')).toHaveText('e2e-mini-app:obj-1,obj-2', {
				timeout: 10000,
			})

			// The platform policy is the only CSP in the document: the agent meta
			// was stripped, and the survivor is byte-identical to the platform's.
			const cspMetas = await frame.evaluate(() =>
				Array.from(document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')).map(
					(m) => m.getAttribute('content'),
				),
			)
			expect(cspMetas).toEqual([PLATFORM_CSP])

			// The data slot node survives and the global is populated from it.
			const appData = await frame.evaluate(() => ({
				global: (window as unknown as Record<string, unknown>).__MASKIN_APP_DATA__,
				slot:
					(document.getElementById('maskin-state') as HTMLScriptElement | null)?.textContent ??
					null,
			}))
			expect(appData.global).toEqual({ app: 'e2e-mini-app', objects: ['obj-1', 'obj-2'] })
			expect(appData.slot).toContain('e2e-mini-app')

			// Egress is dead from inside the frame: CSP connect-src 'none' rejects
			// any fetch-class request before it touches the network.
			const egress = await frame.evaluate(async () => {
				try {
					await fetch('https://example.com/', { mode: 'no-cors' })
					return 'resolved'
				} catch (err) {
					return `blocked:${(err as Error).name}`
				}
			})
			expect(egress).toMatch(/^blocked:/)
		})
	}
})
