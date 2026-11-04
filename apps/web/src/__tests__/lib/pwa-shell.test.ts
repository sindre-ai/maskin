import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const indexHtml = readFileSync(join(__dirname, '../../../index.html'), 'utf8')
const manifest = JSON.parse(
	readFileSync(join(__dirname, '../../../public/manifest.webmanifest'), 'utf8'),
)

describe('installed web app shell (iOS Home Screen)', () => {
	it('asks for full-screen display, so Safari draws no browser buttons over the UI', () => {
		expect(manifest.display).toBe('standalone')
		expect(indexHtml).toMatch(/<meta name="apple-mobile-web-app-capable" content="yes"/)
		expect(indexHtml).toMatch(/<meta name="mobile-web-app-capable" content="yes"/)
	})

	it('launches straight into the app, not the maskin.io landing page (which has its own browser-mode manifest)', () => {
		expect(manifest.start_url).toBe('/workspaces')
		expect(manifest.scope).toBe('/')
	})
})
