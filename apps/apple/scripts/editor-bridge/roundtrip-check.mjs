// Opens each real fixture in the bundled page (headless Chromium), replaces one word in the first
// paragraph, and checks the saved text differs from the original in that paragraph only.
// Usage: node roundtrip-check.mjs <playwright-module-dir>   (needs `npm i playwright` somewhere)
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../..')
const require = createRequire(path.join(process.argv[2] ?? process.cwd(), 'x.js'))
const { chromium } = require('playwright')
const page_url = pathToFileURL(
	path.join(root, 'apps/apple/Sources/MaskinFeatures/Objects/EditorPage/editor.html'),
).href
const dir = path.join(root, 'packages/markdown/src/__tests__/fixtures')

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 700 } })
let failed = 0
for (const name of readdirSync(dir)
	.filter((f) => f.endsWith('.md'))
	.sort()) {
	const original = readFileSync(path.join(dir, name), 'utf8')
	const page = await ctx.newPage()
	await page.goto(page_url)
	await page.evaluate(([md]) => window.maskinEditor.open(md, 'Description'), [original])
	await page.waitForTimeout(400)
	const readOnly = await page.evaluate(() => !document.querySelector('.ProseMirror'))
	if (readOnly) {
		const saved = await page.evaluate(() => window.maskinEditor.getMarkdown())
		console.log(
			`${saved === original ? 'ok  ' : 'FAIL'} ${name}: opened read-only, text ${saved === original ? 'unchanged' : 'CHANGED'}`,
		)
		if (saved !== original) failed++
		await page.close()
		continue
	}
	// Untouched save must be byte for byte the original.
	const untouched = await page.evaluate(() => window.maskinEditor.getMarkdown())
	// Replace the first word of the first plain paragraph.
	const target = await page.evaluate(() => {
		const p = [...document.querySelectorAll('.ProseMirror > p')].find((e) =>
			/\b[A-Za-z]{4,}\b/.test(e.textContent),
		)
		if (!p) return null
		const m = p.textContent.match(/\b[A-Za-z]{4,}\b/)
		return { text: p.textContent, word: m[0] }
	})
	if (!target) {
		console.log(
			`${untouched === original ? 'ok  ' : 'FAIL'} ${name}: no plain paragraph to edit, untouched save ${untouched === original ? 'identical' : 'DIFFERS'}`,
		)
		if (untouched !== original) failed++
		await page.close()
		continue
	}
	await page.evaluate(({ word }) => {
		const p = [...document.querySelectorAll('.ProseMirror > p')].find((e) =>
			e.textContent.includes(word),
		)
		const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const i = n.textContent.indexOf(word)
			if (i >= 0) {
				const r = document.createRange()
				r.setStart(n, i)
				r.setEnd(n, i + word.length)
				const s = getSelection()
				s.removeAllRanges()
				s.addRange(r)
				return
			}
		}
	}, target)
	await page.keyboard.type('ZZEDIT')
	const saved = await page.evaluate(() => window.maskinEditor.getMarkdown())
	// Blocks are the text between blank lines; the edit may change the one block it landed in.
	const a = original.split('\n\n')
	const b = saved.split('\n\n')
	let changed = 0
	for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed++
	const ok =
		untouched === original && saved.includes('ZZEDIT') && a.length === b.length && changed === 1
	if (!ok) failed++
	console.log(
		`${ok ? 'ok  ' : 'FAIL'} ${name}: untouched ${untouched === original ? 'identical' : 'DIFFERS'}, edit changed ${changed} block(s) of ${a.length}`,
	)
	await page.close()
}
await browser.close()
process.exit(failed ? 1 : 0)
