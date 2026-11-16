import { injectIntoHtml } from '@/lib/mini-app'

/**
 * A page inside an iframe reads `prefers-color-scheme` from the browser's own setting,
 * not from the app, so a view can come up light inside a dark app (or the reverse). This
 * makes the page's light and dark styles follow the app's theme instead, without the file
 * being rewritten by its author:
 *
 * - every `(prefers-color-scheme: dark|light)` test in the page's CSS is replaced by one
 *   that is simply true or false for the app's theme;
 * - `window.matchMedia` answers the same way for the page's scripts;
 * - the document's `color-scheme` is set, so unstyled parts (page background, scrollbars,
 *   form controls) match.
 */
const SCHEME_QUERY_RE = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi
// A width test that is true / false for any real frame.
const ALWAYS = '(min-width: 0px)'
const NEVER = '(max-width: 0px)'

export function applyAppTheme(html: string, theme: 'light' | 'dark'): string {
	const rewritten = html.replace(SCHEME_QUERY_RE, (_match, scheme: string) =>
		scheme.toLowerCase() === theme ? ALWAYS : NEVER,
	)
	const script = [
		`var t=${JSON.stringify(theme)},o=window.matchMedia&&window.matchMedia.bind(window);`,
		'if(!o)return;',
		'window.matchMedia=function(q){',
		'var m=/prefers-color-scheme\\s*:\\s*(dark|light)/i.exec(String(q));',
		'if(!m)return o(q);',
		`return o(m[1].toLowerCase()===t?'${ALWAYS}':'${NEVER}')}`,
	].join('')
	const patch = [
		`<meta name="color-scheme" content="${theme}">`,
		`<style>:root{color-scheme:${theme} !important}</style>`,
		`<script>(function(){${script}})();</script>`,
	].join('')
	return injectIntoHtml(rewritten, patch)
}
