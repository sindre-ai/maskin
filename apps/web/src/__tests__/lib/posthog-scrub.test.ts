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

	it('drops the query string from the session entry, first-visit and set-once addresses', () => {
		const authorize = 'https://app.example/oauth/authorize?state=secret-state&code_challenge=abc'
		const login = `https://app.example/login?redirect=${encodeURIComponent('/oauth/authorize?state=secret-state')}`
		const event = scrubAuthorizeUrls({
			properties: {
				$current_url: authorize,
				$session_entry_url: authorize,
				$session_entry_referrer: authorize,
				$set_once: { $initial_current_url: login },
			},
			$set: { $current_url: authorize },
			$set_once: {
				$current_url: authorize,
				$initial_current_url: login,
				$initial_referrer: authorize,
				$initial_pathname: '/oauth/authorize',
			},
		})
		expect(JSON.stringify(event)).not.toContain('secret-state')
		expect(event.properties.$session_entry_url).toBe('https://app.example/oauth/authorize')
		expect(event.$set_once.$initial_current_url).toBe('https://app.example/login')
		expect(event.$set_once.$initial_pathname).toBe('/oauth/authorize')
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
