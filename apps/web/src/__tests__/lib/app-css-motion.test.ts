import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(join(__dirname, '../../app.css'), 'utf8')

describe('app.css — motion tokens & reduced-motion guard', () => {
	it('declares the v2 named motion durations (Tailwind covers 150/200/300 by default)', () => {
		expect(appCss).toMatch(/--duration-180:\s*180ms/)
		expect(appCss).toMatch(/--duration-250:\s*250ms/)
		expect(appCss).toMatch(/--duration-slide:\s*300ms/)
	})

	it('wires the semantic duration tokens up as authored utility classes', () => {
		expect(appCss).toMatch(/@utility duration-180[\s\S]*?transition-duration:\s*var\(--duration-180\)/)
		expect(appCss).toMatch(/@utility duration-250[\s\S]*?transition-duration:\s*var\(--duration-250\)/)
		expect(appCss).toMatch(
			/@utility duration-slide[\s\S]*?transition-duration:\s*var\(--duration-slide\)/,
		)
	})

	it('declares the v2 easing tokens in @theme', () => {
		expect(appCss).toMatch(/--ease-standard:\s*cubic-bezier\(0\.4,\s*0,\s*0\.2,\s*1\)/)
		expect(appCss).toMatch(/--ease-emphasized:\s*cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/)
		expect(appCss).toMatch(/--ease-out:\s*ease-out/)
	})

	it('collapses transitions and animations under prefers-reduced-motion (disabled, not slowed)', () => {
		expect(appCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
		expect(appCss).toMatch(/animation-duration:\s*0\.001ms\s*!important/)
		expect(appCss).toMatch(/transition-duration:\s*0\.001ms\s*!important/)
		expect(appCss).toMatch(/animation-iteration-count:\s*1\s*!important/)
		expect(appCss).toMatch(/scroll-behavior:\s*auto\s*!important/)
	})
})
