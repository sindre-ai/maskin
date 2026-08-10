import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'
import { describe, expect, it } from 'vitest'

// The seed mini-app: this fixture is a byte-copy of the live workspace file
// (maskin file eab40c73-f185-4ddd-8a51-9d1742069a40). The slot contract is
// that every byte of content a render needs lives inside the
// <script id="maskin-state" type="application/json"> node, exposed as
// window.__MASKIN_APP_DATA__ — the renderer must draw everything from there.
interface AppMeta {
	title: string
	subtitle: string
	type: string
}

interface MiniAppItem {
	id: string
	type: string
	status: string
	title: string
	url: string
	summary: string
}

interface MiniAppModule {
	id: string
	title: string
	items: string[]
}

interface MiniAppState {
	file: string
	app: AppMeta
	modules: MiniAppModule[]
	items: MiniAppItem[]
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/pm-curriculum.html')

const html = readFileSync(FIXTURE, 'utf8')

function slotText(fileContents: string): string {
	const m = fileContents.match(
		/<script id="maskin-state" type="application\/json">([\s\S]*?)<\/script>/,
	)
	if (!m) {
		throw new Error('maskin-state slot node must exist in the fixture')
	}
	return m[1]
}

function parseState(fileContents: string): MiniAppState {
	return JSON.parse(slotText(fileContents)) as MiniAppState
}

function renderApp(fileContents: string) {
	const issues: string[] = []
	const virtualConsole = new VirtualConsole()
	virtualConsole.on('jsdomError', (err: Error) => issues.push(String(err)))
	virtualConsole.on('error', (...args: unknown[]) => issues.push(args.map(String).join(' ')))
	const dom = new JSDOM(fileContents, {
		runScripts: 'dangerously',
		virtualConsole,
		url: 'https://app.local/',
	})
	return { dom, issues }
}

describe('pm-curriculum.html mini-app', () => {
	it('bakes all curriculum data into the maskin-state slot as JSON', () => {
		const state = parseState(html)

		expect(state.file).toBe('pm-curriculum.html')
		expect(state.app.title).toBe('PM Learning Curriculum')
		expect(state.app.type).toBe('mini-app')
		expect(state.modules).toHaveLength(3)
		expect(state.items).toHaveLength(7)

		// Every work item carries the fields a curriculum render needs.
		for (const item of state.items) {
			expect(item).toMatchObject({
				id: expect.any(String),
				type: expect.stringMatching(/^(knowledge|insight)$/),
				status: expect.stringMatching(/^(validated|clustered|new)$/),
				title: expect.any(String),
				url: expect.stringMatching(/^https:\/\/maskin\.io\//),
				summary: expect.any(String),
			})
		}

		// Module groupings must reference real items (no dangling ids).
		for (const mod of state.modules) {
			for (const id of mod.items) {
				expect(state.items.some((item) => item.id === id)).toBe(true)
			}
		}
	})

	it('renders the full curriculum from the slot without console errors', () => {
		const { dom, issues } = renderApp(html)
		const window = dom.window as unknown as {
			document: Document
			__MASKIN_APP_DATA__: MiniAppState
		}
		const { document, __MASKIN_APP_DATA__ } = window

		// The slot is exposed as the app-data global, exactly per contract.
		expect(__MASKIN_APP_DATA__).toBeDefined()
		expect(__MASKIN_APP_DATA__.app.title).toBe('PM Learning Curriculum')

		const root = document.getElementById('root')
		expect(root).not.toBeNull()
		expect(document.querySelectorAll('.module')).toHaveLength(3)
		expect(document.querySelectorAll('.item')).toHaveLength(7)
		expect(root?.textContent).toContain('PM Learning Curriculum')
		expect(root?.textContent).toContain('The Artifacts pattern')
		expect(root?.textContent).toContain('Live surfaces')
		// Every item title makes it to the DOM.
		const state = parseState(html)
		for (const item of state.items) {
			expect(root?.textContent).toContain(item.title)
		}

		expect(issues).toEqual([])
	})

	it('derives content from the slot only — nothing hardcoded outside it', () => {
		const state = parseState(html)
		const slot = slotText(html)
		const slotStart = html.indexOf(slot)
		expect(slotStart).toBeGreaterThan(-1)
		const slotEnd = slotStart + slot.length
		const outside = html.slice(0, slotStart) + html.slice(slotEnd)

		// Titles, summaries, app text and object URLs must not appear anywhere
		// outside the slot — otherwise a regenerated slot could leave stale
		// content hanging in the file.
		const sensitive = [
			state.app.title,
			state.app.subtitle,
			...state.items.flatMap((item) => [item.title, item.summary, item.url]),
			...state.modules.flatMap((mod) => [mod.id, mod.title]),
		]
		for (const text of sensitive) {
			expect(outside, `content leaked outside the slot: ${text}`).not.toContain(text)
		}
	})

	it('makes no network calls and loads no external resources', () => {
		// Egress-capable APIs must be absent from the whole file.
		for (const pattern of [
			'fetch(',
			'XMLHttpRequest',
			'WebSocket',
			'EventSource',
			'navigator.sendBeacon',
			'import(',
		]) {
			expect(html).not.toContain(pattern)
		}
		// No external scripts, stylesheets, images or fonts.
		for (const pattern of ['<script src', '<link', '<img', "url('", 'url("']) {
			expect(html).not.toContain(pattern)
		}
		// The only https:// references in the file live inside the slot as data
		// (destinations for user-initiated "View object" links, never fetched).
		const slot = slotText(html)
		const slotStart = html.indexOf(slot)
		const slotEnd = slotStart + slot.length
		for (const m of html.matchAll(/https:\/\//g)) {
			const at = m.index ?? -1
			expect(at).toBeGreaterThanOrEqual(slotStart)
			expect(at).toBeLessThan(slotEnd)
		}
	})

	it('is a single self-contained HTML file app', () => {
		const { dom } = renderApp(html)
		const { document } = dom.window

		expect(html.trimStart().startsWith('<!DOCTYPE html>')).toBe(true)
		expect(document.documentElement.getAttribute('lang')).toBe('en')

		// All style and script is inline; there is nothing to fetch alongside
		// this one file. The state slot is the single source of content.
		const scripts = [...document.querySelectorAll('script')]
		expect(scripts.some((s) => s.getAttribute('src'))).toBe(false)
		expect(document.querySelector('link[rel="stylesheet"]')).toBeNull()
		expect(document.querySelector('style')).not.toBeNull()
		expect(document.getElementById('maskin-state')).not.toBeNull()
	})
})
