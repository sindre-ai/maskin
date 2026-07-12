import { generateKeyPairSync } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
	createAppJwt,
	mintAppJwtFromEnv,
	parsePrivateKey,
} from '../../../../lib/integrations/providers/github/app-jwt'

const { privateKey: testPrivateKeyPem } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

describe('parsePrivateKey', () => {
	it('returns a PEM with real newlines when input has literal \\n sequences', () => {
		const escaped = testPrivateKeyPem.replace(/\n/g, '\\n')
		const parsed = parsePrivateKey(escaped)
		expect(parsed).toContain('-----BEGIN')
		expect(parsed).toContain('-----END')
		expect(parsed).not.toContain('\\n')
	})

	it('normalises a PEM whose newlines were collapsed to spaces (Coolify shape)', () => {
		const spaced = testPrivateKeyPem.replace(/\n/g, ' ')
		const parsed = parsePrivateKey(spaced)
		expect(parsed.split('\n').length).toBeGreaterThan(3)
		expect(parsed).toContain('-----BEGIN')
	})

	it('decodes a base64-encoded PEM back to text', () => {
		const base64 = Buffer.from(testPrivateKeyPem).toString('base64')
		const parsed = parsePrivateKey(base64)
		expect(parsed).toContain('-----BEGIN')
	})
})

describe('createAppJwt', () => {
	it('returns a three-segment RS256 JWT', () => {
		const jwt = createAppJwt('12345', testPrivateKeyPem)
		expect(jwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
		const [header, payload] = jwt.split('.')
		const decodedHeader = JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8'))
		expect(decodedHeader).toEqual({ alg: 'RS256', typ: 'JWT' })
		const decodedPayload = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'))
		expect(decodedPayload.iss).toBe(12345)
		expect(decodedPayload.exp - decodedPayload.iat).toBe(660)
	})
})

describe('mintAppJwtFromEnv', () => {
	const originalId = process.env.TEST_APP_ID
	const originalKey = process.env.TEST_APP_PRIVATE_KEY

	beforeAll(() => {
		process.env.TEST_APP_ID = '9999'
		process.env.TEST_APP_PRIVATE_KEY = testPrivateKeyPem
	})

	afterEach(() => {
		process.env.TEST_APP_ID = '9999'
		process.env.TEST_APP_PRIVATE_KEY = testPrivateKeyPem
	})

	afterAll(() => {
		process.env.TEST_APP_ID = originalId
		process.env.TEST_APP_PRIVATE_KEY = originalKey
	})

	it('reads env-referenced credentials and returns a signed JWT', () => {
		const jwt = mintAppJwtFromEnv('TEST_APP_ID', 'TEST_APP_PRIVATE_KEY')
		const [, payload] = jwt.split('.')
		const decoded = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'))
		expect(decoded.iss).toBe(9999)
	})

	it('throws a clear error when the id env var is missing', () => {
		process.env.TEST_APP_ID = ''
		expect(() => mintAppJwtFromEnv('TEST_APP_ID', 'TEST_APP_PRIVATE_KEY')).toThrow(
			'TEST_APP_ID environment variable is required',
		)
	})

	it('throws a clear error when the key env var is missing', () => {
		process.env.TEST_APP_PRIVATE_KEY = ''
		expect(() => mintAppJwtFromEnv('TEST_APP_ID', 'TEST_APP_PRIVATE_KEY')).toThrow(
			'TEST_APP_PRIVATE_KEY environment variable is required',
		)
	})
})
