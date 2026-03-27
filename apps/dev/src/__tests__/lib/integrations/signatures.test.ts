import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
	verifyHmacSha1,
	verifyHmacSha256,
	verifyTimestampSignature,
} from '../../../lib/integrations/webhooks/signatures'

describe('verifyHmacSha256', () => {
	const secret = 'test-secret'
	const body = '{"event":"test"}'

	function computeSha256(data: string, key: string, prefix = '') {
		const digest = createHmac('sha256', key).update(data).digest('hex')
		return `${prefix}${digest}`
	}

	it('returns true for valid signature', () => {
		const signature = computeSha256(body, secret)
		expect(verifyHmacSha256(body, signature, secret)).toBe(true)
	})

	it('returns false for invalid signature', () => {
		expect(verifyHmacSha256(body, 'invalid-sig', secret)).toBe(false)
	})

	it('returns true with prefix', () => {
		const signature = computeSha256(body, secret, 'sha256=')
		expect(verifyHmacSha256(body, signature, secret, 'sha256=')).toBe(true)
	})

	it('returns false when prefix does not match', () => {
		const signatureWithoutPrefix = computeSha256(body, secret)
		expect(verifyHmacSha256(body, signatureWithoutPrefix, secret, 'sha256=')).toBe(false)
	})

	it('returns false for length mismatch', () => {
		expect(verifyHmacSha256(body, 'short', secret)).toBe(false)
	})
})

describe('verifyHmacSha1', () => {
	const secret = 'test-secret'
	const body = '{"event":"test"}'

	function computeSha1(data: string, key: string, prefix = '') {
		const digest = createHmac('sha1', key).update(data).digest('hex')
		return `${prefix}${digest}`
	}

	it('returns true for valid signature', () => {
		const signature = computeSha1(body, secret)
		expect(verifyHmacSha1(body, signature, secret)).toBe(true)
	})

	it('returns false for invalid signature', () => {
		expect(verifyHmacSha1(body, 'invalid-sig', secret)).toBe(false)
	})

	it('returns true with prefix', () => {
		const signature = computeSha1(body, secret, 'sha1=')
		expect(verifyHmacSha1(body, signature, secret, 'sha1=')).toBe(true)
	})
})

describe('verifyTimestampSignature', () => {
	const secret = 'timestamp-secret'
	const body = '{"data":"value"}'

	function makeTimestampSignature(
		ts: string,
		bodyStr: string,
		key: string,
		template: string,
		prefix = '',
	) {
		const baseString = template.replace('{timestamp}', ts).replace('{body}', bodyStr)
		const digest = createHmac('sha256', key).update(baseString).digest('hex')
		return `${prefix}${digest}`
	}

	it('returns true for valid timestamp signature', () => {
		const timestamp = String(Math.floor(Date.now() / 1000))
		const template = 'v0:{timestamp}:{body}'
		const signature = makeTimestampSignature(timestamp, body, secret, template, 'v0=')

		expect(
			verifyTimestampSignature(
				body,
				{ 'x-timestamp': timestamp, 'x-signature': signature },
				secret,
				{
					timestampHeader: 'x-timestamp',
					signatureHeader: 'x-signature',
					bodyTemplate: template,
					signaturePrefix: 'v0=',
				},
			),
		).toBe(true)
	})

	it('returns false for expired timestamp', () => {
		const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600)
		const template = 'v0:{timestamp}:{body}'
		const signature = makeTimestampSignature(oldTimestamp, body, secret, template, 'v0=')

		expect(
			verifyTimestampSignature(
				body,
				{ 'x-timestamp': oldTimestamp, 'x-signature': signature },
				secret,
				{
					timestampHeader: 'x-timestamp',
					signatureHeader: 'x-signature',
					bodyTemplate: template,
					signaturePrefix: 'v0=',
					maxAgeSeconds: 300,
				},
			),
		).toBe(false)
	})

	it('returns false when timestamp header is missing', () => {
		expect(
			verifyTimestampSignature(body, { 'x-signature': 'something' }, secret, {
				timestampHeader: 'x-timestamp',
				signatureHeader: 'x-signature',
				bodyTemplate: 'v0:{timestamp}:{body}',
			}),
		).toBe(false)
	})

	it('returns false when signature header is missing', () => {
		const timestamp = String(Math.floor(Date.now() / 1000))
		expect(
			verifyTimestampSignature(body, { 'x-timestamp': timestamp }, secret, {
				timestampHeader: 'x-timestamp',
				signatureHeader: 'x-signature',
				bodyTemplate: 'v0:{timestamp}:{body}',
			}),
		).toBe(false)
	})

	it('returns false for tampered body', () => {
		const timestamp = String(Math.floor(Date.now() / 1000))
		const template = 'v0:{timestamp}:{body}'
		const signature = makeTimestampSignature(timestamp, body, secret, template)

		expect(
			verifyTimestampSignature(
				'{"data":"tampered"}',
				{ 'x-timestamp': timestamp, 'x-signature': signature },
				secret,
				{
					timestampHeader: 'x-timestamp',
					signatureHeader: 'x-signature',
					bodyTemplate: template,
				},
			),
		).toBe(false)
	})
})
