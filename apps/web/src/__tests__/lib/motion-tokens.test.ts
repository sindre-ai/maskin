import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Load the raw stylesheet once — asserting the source-of-truth text keeps this
// test independent of the Tailwind/Vite build pipeline.
const appCss = readFileSync(join(__dirname, '..', '..', 'app.css'), 'utf8')

describe('motion tokens in app.css', () => {
	// Mirrors .claude/skills/maskin-design/tokens/motion.css. If the design
	// system's motion spec changes, update both files in lockstep.
	it('declares the semantic motion tokens the design system expects', () => {
		expect(appCss).toMatch(/--duration-slide:\s*300ms/)
		expect(appCss).toMatch(/--ease-standard:\s*cubic-bezier\(0\.4,\s*0,\s*0\.2,\s*1\)/)
		expect(appCss).toMatch(/--ease-emphasized:\s*cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/)
	})

	it('installs a global prefers-reduced-motion guard that kills motion, not just slows it', () => {
		expect(appCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
		expect(appCss).toMatch(/animation-duration:\s*0\.001ms\s*!important/)
		expect(appCss).toMatch(/transition-duration:\s*0\.001ms\s*!important/)
		expect(appCss).toMatch(/animation-iteration-count:\s*1\s*!important/)
		expect(appCss).toMatch(/scroll-behavior:\s*auto\s*!important/)
	})
})
