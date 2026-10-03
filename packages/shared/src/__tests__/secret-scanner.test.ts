import { describe, expect, it } from 'vitest'
import {
	SECRET_PATTERNS,
	findHighConfidenceSecret,
	redactSecrets,
	redactionMarker,
	scanForSecrets,
} from '../secret-scanner'

// Obviously fake values, assembled at runtime so no token-shaped literal sits in the repo.
const fake = {
	cloudflare: `cfut_${'A1'.repeat(20)}`,
	github: `ghp_${'a'.repeat(36)}`,
	githubFine: `github_pat_${'b'.repeat(82)}`,
	stripe: `sk_live_${'c'.repeat(24)}`,
	stripeTest: `sk_test_${'d'.repeat(30)}`,
	slack: `xoxb-${'1'.repeat(24)}`,
	openai: `sk-${'e'.repeat(48)}`,
	openaiProj: `sk-proj-${'f'.repeat(48)}`,
}

describe('scanForSecrets high confidence', () => {
	it.each([
		['cloudflare', fake.cloudflare, 'cloudflare'],
		['github pat', fake.github, 'github'],
		['github fine-grained', fake.githubFine, 'github'],
		['stripe live', fake.stripe, 'stripe'],
		['stripe test', fake.stripeTest, 'stripe'],
		['slack', fake.slack, 'slack'],
		['openai-style', fake.openai, 'openai-style'],
		['openai-style proj', fake.openaiProj, 'openai-style'],
	])('detects %s inside a sentence', (_label, secret, provider) => {
		const text = `here is my key ${secret} please use it`
		const [m] = scanForSecrets(text)
		expect(m?.confidence).toBe('high')
		expect(m?.provider).toBe(provider)
		expect(m?.value).toBe(secret)
		expect(text.slice(m?.start, m?.end)).toBe(secret)
	})

	it('accepts all three Cloudflare prefixes', () => {
		for (const prefix of ['cfut', 'cfat', 'cfk']) {
			expect(findHighConfidenceSecret(`${prefix}_${'x'.repeat(40)}`)?.provider).toBe('cloudflare')
		}
	})

	it('rejects Cloudflare tails shorter than 40 or longer than 64', () => {
		expect(findHighConfidenceSecret(`cfut_${'x'.repeat(39)}`)).toBeNull()
		expect(findHighConfidenceSecret(`cfut_${'x'.repeat(65)}`)).toBeNull()
	})

	it('does not match Notion secret_ or JWT eyJ strings', () => {
		const notion = `secret_${'n'.repeat(43)}`
		const jwt = `eyJ${'h'.repeat(20)}.eyJ${'p'.repeat(30)}.${'s'.repeat(40)}`
		expect(findHighConfidenceSecret(notion)).toBeNull()
		expect(findHighConfidenceSecret(jwt)).toBeNull()
	})

	it('only reports the five allowed providers', () => {
		const providers = SECRET_PATTERNS.filter((p) => p.confidence === 'high').map((p) => p.provider)
		expect(providers.sort()).toEqual(['cloudflare', 'github', 'openai-style', 'slack', 'stripe'])
	})

	it('checks Stripe before OpenAI-style and the longest match wins', () => {
		const ids = SECRET_PATTERNS.map((p) => p.id)
		expect(ids.indexOf('stripe')).toBeLessThan(ids.indexOf('openai-style'))
		// An sk- key containing a longer tail is one openai-style match, not two.
		const matches = scanForSecrets(`${fake.openaiProj} and ${fake.stripe}`)
		expect(matches.map((m) => m.provider)).toEqual(['openai-style', 'stripe'])
	})

	it('finds several secrets in one message', () => {
		const matches = scanForSecrets(`${fake.github} ${fake.slack}`)
		expect(matches.map((m) => m.provider)).toEqual(['github', 'slack'])
	})

	it('skips muted pattern ids', () => {
		expect(scanForSecrets(fake.github, { mutedPatternIds: new Set(['github']) })).toEqual([])
	})
})

describe('scanForSecrets low confidence', () => {
	it('routes cf-ray strings to the amber path', () => {
		const [m] = scanForSecrets('ray 8a1b2c3d4e5f6a7b-ARN in the header')
		expect(m).toMatchObject({ confidence: 'low', patternId: 'cf-ray', provider: null })
	})

	it('routes a legacy unprefixed 40-char Cloudflare token to amber', () => {
		const [m] = scanForSecrets(`token ${'Zq9_-'.repeat(8)}`)
		expect(m).toMatchObject({ confidence: 'low', patternId: 'long-blob' })
	})

	it('routes other 40+ char blobs to amber', () => {
		const [m] = scanForSecrets('x'.repeat(64))
		expect(m).toMatchObject({ confidence: 'low' })
	})

	it('does not report a high-confidence key a second time as a blob', () => {
		const matches = scanForSecrets(fake.openai)
		expect(matches).toHaveLength(1)
		expect(matches[0]?.confidence).toBe('high')
	})

	it('highOnly ignores amber matches', () => {
		expect(scanForSecrets('x'.repeat(64), { highOnly: true })).toEqual([])
	})

	it('ignores ordinary prose and short tokens', () => {
		expect(scanForSecrets('please check the sk-learn docs and notion secret_abc')).toEqual([])
	})
})

describe('redaction', () => {
	it('keeps the provider prefix and names the vault entry', () => {
		expect(redactionMarker(fake.cloudflare, 'NAME')).toBe('cfut_[REDACTED · vaulted as NAME]')
		expect(redactionMarker(fake.stripe, 'Stripe')).toBe('sk_live_[REDACTED · vaulted as Stripe]')
		expect(redactionMarker(fake.openaiProj, 'X')).toBe('sk-proj-[REDACTED · vaulted as X]')
	})

	it('rewrites every match and nothing else', () => {
		const text = `a ${fake.github} b ${fake.slack} c`
		const out = redactSecrets(text, scanForSecrets(text), 'NAME')
		expect(out).toBe('a ghp_[REDACTED · vaulted as NAME] b xoxb-[REDACTED · vaulted as NAME] c')
	})

	it('never trips on its own marker', () => {
		for (const secret of Object.values(fake)) {
			const marker = redactionMarker(secret, 'NAME')
			expect(scanForSecrets(marker)).toEqual([])
		}
	})
})

describe('scan performance', () => {
	// Warm the regex cache, then take the best of several runs so a noisy CI box
	// does not flake the budget.
	const best = (text: string) => {
		scanForSecrets(text)
		let min = Number.POSITIVE_INFINITY
		for (let i = 0; i < 10; i++) {
			const t0 = performance.now()
			scanForSecrets(text)
			min = Math.min(min, performance.now() - t0)
		}
		return min
	}

	it('scans a message under 2 KB in under 1 ms', () => {
		const text = `${'lorem ipsum dolor sit amet '.repeat(60)}${fake.github}`.slice(0, 1900)
		expect(text.length).toBeLessThan(2048)
		expect(best(text)).toBeLessThan(1)
	})

	it('scans a long paste in under 10 ms', () => {
		const text = `${'lorem-ipsum_dolor sit amet '.repeat(4000)}${fake.github}`
		expect(best(text)).toBeLessThan(10)
	})

	it('stays linear on a pathological run of token characters', () => {
		expect(best('a'.repeat(100_000))).toBeLessThan(50)
	})
})
