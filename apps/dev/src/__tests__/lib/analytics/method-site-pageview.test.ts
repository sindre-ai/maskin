import { describe, expect, it } from 'vitest'
import {
	METHOD_SITE_PAGEVIEW_EVENT,
	buildMethodSitePageviewScript,
	shouldInitPostHog,
} from '../../../lib/analytics/method-site-pageview'

describe('shouldInitPostHog', () => {
	it('allows external hosts', () => {
		expect(shouldInitPostHog('maskin.io')).toBe(true)
		expect(shouldInitPostHog('www.example.com')).toBe(true)
	})

	it('blocks preview and localhost variants', () => {
		expect(shouldInitPostHog('preview.maskin.io')).toBe(false)
		expect(shouldInitPostHog('PREVIEW.maskin.IO')).toBe(false)
		expect(shouldInitPostHog('localhost')).toBe(false)
		expect(shouldInitPostHog('localhost:3000')).toBe(false)
		expect(shouldInitPostHog('localhost:5173')).toBe(false)
		expect(shouldInitPostHog('127.0.0.1')).toBe(false)
		expect(shouldInitPostHog('127.0.0.1:3000')).toBe(false)
		expect(shouldInitPostHog('[::1]')).toBe(false)
		expect(shouldInitPostHog('[::1]:3000')).toBe(false)
	})

	it('treats empty/undefined host as blocked', () => {
		expect(shouldInitPostHog(null)).toBe(false)
		expect(shouldInitPostHog(undefined)).toBe(false)
		expect(shouldInitPostHog('')).toBe(false)
	})
})

describe('buildMethodSitePageviewScript', () => {
	const key = 'phc_test_key'

	it('emits a script that names the event and initialises the SDK', () => {
		const script = buildMethodSitePageviewScript({
			apiKey: key,
			apiHost: 'https://eu.i.posthog.com',
			chapterSlug: 'loops',
		})
		// Bundle-grep half of the DoD — the event name and the init call must
		// both appear literally in the shipped bundle.
		expect(script).toContain(METHOD_SITE_PAGEVIEW_EVENT)
		expect(script).toContain('posthog.init(')
		expect(script).toContain('posthog.capture(')
	})

	it('embeds the three required event properties', () => {
		const script = buildMethodSitePageviewScript({
			apiKey: key,
			chapterSlug: 'loops',
		})
		expect(script).toContain('path:')
		expect(script).toContain('chapter_slug:')
		expect(script).toContain('referring_domain:')
	})

	it('inlines the chapter slug and posthog config as JSON literals', () => {
		const script = buildMethodSitePageviewScript({
			apiKey: key,
			apiHost: 'https://us.i.posthog.com',
			chapterSlug: 'sindre-the-meta-agent',
		})
		expect(script).toContain('"sindre-the-meta-agent"')
		expect(script).toContain('"phc_test_key"')
		expect(script).toContain('"https://us.i.posthog.com"')
	})

	it('escapes hostile chapter slugs so a compiled title cannot break out of the script', () => {
		const withQuote = buildMethodSitePageviewScript({
			apiKey: key,
			chapterSlug: 'evil"; alert(1); //',
		})
		// JSON.stringify escapes the embedded quote — the sequence that would
		// close the string literal in JS is neutralised.
		expect(withQuote).toContain('evil\\"; alert(1); //')
		expect(withQuote).toContain('chapter_slug: "evil\\"; alert(1); //"')

		// A slug containing `</script>` would otherwise close the surrounding
		// script tag: JSON.stringify does not escape `<`, so the helper must.
		const withCloseTag = buildMethodSitePageviewScript({
			apiKey: key,
			chapterSlug: '</script><img onerror=alert(1)>',
		})
		expect(withCloseTag).not.toContain('</script><img')
		expect(withCloseTag).toContain('\\u003c/script>\\u003cimg')
	})

	it('gates init behind a host allowlist inline', () => {
		const script = buildMethodSitePageviewScript({
			apiKey: key,
			chapterSlug: '',
		})
		expect(script).toContain('preview.maskin.io')
		expect(script).toContain('localhost')
	})

	it('emits a bundle-grep-friendly no-op when the api key is unset', () => {
		const script = buildMethodSitePageviewScript({
			apiKey: undefined,
			chapterSlug: 'loops',
		})
		expect(script).toContain(METHOD_SITE_PAGEVIEW_EVENT)
		expect(script).not.toContain('posthog.init(')
		expect(script).not.toContain('posthog.capture(')
	})

	it('uses the EU host by default', () => {
		const script = buildMethodSitePageviewScript({
			apiKey: key,
			chapterSlug: '',
		})
		expect(script).toContain('https://eu.i.posthog.com')
	})
})
