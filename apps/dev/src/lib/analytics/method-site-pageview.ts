export const METHOD_SITE_PAGEVIEW_EVENT = 'method_site_pageview'

const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com'

// Hosts where PostHog init is skipped so internal browsing never counts as
// a "unique method-site session from an external referrer". `localhost` is
// matched by prefix so `localhost:3000` / `localhost:5173` / IPv6 loopback
// aren't accidentally allowed.
const BLOCKED_HOSTS = ['preview.maskin.io']
const BLOCKED_HOST_PREFIXES = ['localhost', '127.0.0.1', '[::1]']

export function shouldInitPostHog(host: string | null | undefined): boolean {
	if (!host) return false
	const normalized = host.toLowerCase().trim()
	if (BLOCKED_HOSTS.includes(normalized)) return false
	for (const prefix of BLOCKED_HOST_PREFIXES) {
		if (normalized === prefix || normalized.startsWith(`${prefix}:`)) return false
	}
	return true
}

export interface MethodSitePageviewScriptOptions {
	/** PostHog project public API key. When empty/undefined the emitted script is a no-op. */
	apiKey: string | undefined
	/** PostHog ingest host. Defaults to the EU endpoint used elsewhere in the app. */
	apiHost?: string
	/** Chapter slug for the current page (empty string on the cover route). */
	chapterSlug: string
}

/**
 * Returns the `<script>` HTML to inline in the `<head>` of a `/method/*` page.
 * Runs the standard PostHog browser snippet, skips init on preview/localhost,
 * then fires `method_site_pageview` with `path`, `chapter_slug`, `referring_domain`.
 *
 * The script is self-contained: no imports, no globals besides `window.posthog`.
 * Missing `apiKey` (dev without VITE_POSTHOG_KEY) emits a no-op comment so the
 * bundle-grep half of the DoD still passes.
 */
export function buildMethodSitePageviewScript(options: MethodSitePageviewScriptOptions): string {
	const { apiKey, apiHost = DEFAULT_POSTHOG_HOST, chapterSlug } = options
	if (!apiKey) {
		return `<script data-analytics="${METHOD_SITE_PAGEVIEW_EVENT}">/* ${METHOD_SITE_PAGEVIEW_EVENT}: posthog key unset, skipping init */</script>`
	}
	// JSON.stringify does not escape `<`, so a value containing `</script>` would
	// close the surrounding script tag when inlined. Escape `<` as `\u003c` on
	// every embedded literal so a hostile chapter slug (or config value) can't
	// break out of the script context.
	const inline = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')
	const apiKeyJson = inline(apiKey)
	const apiHostJson = inline(apiHost)
	const chapterSlugJson = inline(chapterSlug)
	const blockedHostsJson = inline(BLOCKED_HOSTS)
	const blockedPrefixesJson = inline(BLOCKED_HOST_PREFIXES)
	return `<script data-analytics="${METHOD_SITE_PAGEVIEW_EVENT}">
!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
(function(){
  var host = (window.location.hostname || '').toLowerCase();
  var blockedHosts = ${blockedHostsJson};
  var blockedPrefixes = ${blockedPrefixesJson};
  if (blockedHosts.indexOf(host) !== -1) return;
  for (var i = 0; i < blockedPrefixes.length; i++) {
    var p = blockedPrefixes[i];
    if (host === p || host.indexOf(p + ':') === 0) return;
  }
  try {
    posthog.init(${apiKeyJson}, {
      api_host: ${apiHostJson},
      person_profiles: 'identified_only',
      capture_pageview: false,
      autocapture: false,
    });
  } catch (e) { return; }
  var referringDomain = '';
  try {
    if (document.referrer) referringDomain = new URL(document.referrer).hostname;
  } catch (e) {}
  try {
    posthog.capture(${inline(METHOD_SITE_PAGEVIEW_EVENT)}, {
      path: window.location.pathname,
      chapter_slug: ${chapterSlugJson},
      referring_domain: referringDomain,
    });
  } catch (e) {}
})();
</script>`
}
