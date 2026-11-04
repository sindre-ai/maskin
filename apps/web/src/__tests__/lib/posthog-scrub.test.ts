import { scrubAuthorizeUrls } from '@/lib/posthog'

// The consent page's address holds the sign-in request (state, code challenge, return address). The
// page view PostHog records for it, and for the login detour that carries it, must not.
function pageview(url: string) {
	return { properties: { $current_url: url, $referrer: 'https://claude.ai/' } }
}

describe('scrubAuthorizeUrls', () => {
	it('drops the query string of the consent page', () => {
		const event = scrubAuthorizeUrls(
			pageview('https://app.example/oauth/authorize?state=secret-state&code_challenge=abc'),
		)
		expect(event.properties.$current_url).toBe('https://app.example/oauth/authorize')
	})

	it('drops the redirect parameter of the login detour to the consent page', () => {
		const redirect = encodeURIComponent('/oauth/authorize?state=secret-state&code_challenge=abc')
		const event = scrubAuthorizeUrls(pageview(`https://app.example/login?redirect=${redirect}`))
		expect(event.properties.$current_url).toBe('https://app.example/login')
	})

	it('leaves every other page alone', () => {
		const url = 'https://app.example/ws-1/objects?filter=open'
		expect(scrubAuthorizeUrls(pageview(url)).properties.$current_url).toBe(url)
		const login = 'https://app.example/login?redirect=%2Fws-1%2Fsettings'
		expect(scrubAuthorizeUrls(pageview(login)).properties.$current_url).toBe(login)
	})

	it('passes an event with no properties through', () => {
		expect(scrubAuthorizeUrls(null)).toBeNull()
		expect(scrubAuthorizeUrls({})).toEqual({})
	})
})
