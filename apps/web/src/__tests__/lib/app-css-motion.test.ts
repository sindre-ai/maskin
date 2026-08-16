import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(join(__dirname, '../../app.css'), 'utf8')

describe('app.css — motion tokens & reduced-motion guard', () => {
	it('declares the v2 named motion durations in @theme', () => {
		expect(appCss).toMatch(/--duration-150:\s*150ms/)
		expect(appCss).toMatch(/--duration-180:\s*180ms/)
		expect(appCss).toMatch(/--duration-200:\s*200ms/)
		expect(appCss).toMatch(/--duration-250:\s*250ms/)
		expect(appCss).toMatch(/--duration-slide:\s*300ms/)
	})

	it('declares the v2 easing tokens in @theme', () => {
		expect(appCss).toMatch(/--ease-standard:\s*cubic-bezier\(0\.4,\s*0,\s*0\.2,\s*1\)/)
		expect(appCss).toMatch(/--ease-emphasized:\s*cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/)
		expect(appCss).toMatch(/--ease-out:\s*ease-out/)
	})

	it('collapses transitions and animations under prefers-reduced-motion (disabled, not slowed)', () => {
		expect(appCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
		expect(appCss).toMatch(/animation-duration:\s*0\.01ms\s*!important/)
		expect(appCss).toMatch(/transition-duration:\s*0\.01ms\s*!important/)
		expect(appCss).toMatch(/animation-iteration-count:\s*1\s*!important/)
		expect(appCss).toMatch(/scroll-behavior:\s*auto\s*!important/)
	})
})
