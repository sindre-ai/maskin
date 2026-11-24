import { describe, expect, it } from 'vitest'
import {
	CustomerValueError,
	fillCustomerValue,
	validateCustomerValue,
} from '../../../lib/integrations/customer-value'
import type { CustomerValueConfig } from '../../../lib/integrations/types'

const host: CustomerValueConfig = {
	label: 'Looker address',
	placeholder: 'name.cloud.looker.com',
	kind: 'host',
	hostSuffixes: ['looker.com', 'looker.app'],
}
const tenant: CustomerValueConfig = {
	label: 'Tenant ID',
	placeholder: '00000000-0000-0000-0000-000000000000',
	kind: 'tenant',
}

describe('validateCustomerValue (host)', () => {
	it('accepts the vendor domains and lower-cases and trims', () => {
		expect(validateCustomerValue(host, ' Acme.Cloud.Looker.com ')).toBe('acme.cloud.looker.com')
		expect(validateCustomerValue(host, 'abc-123.looker.app')).toBe('abc-123.looker.app')
	})

	it.each([
		['a scheme', 'https://acme.looker.com'],
		['a path', 'acme.looker.com/admin'],
		['a port', 'acme.looker.com:8443'],
		['credentials', 'user@acme.looker.com'],
		['a query', 'acme.looker.com?x=1'],
		['a fragment', 'acme.looker.com#x'],
		['a backslash', 'acme.looker.com\\evil.com'],
		['whitespace inside', 'acme .looker.com'],
		['a bare suffix', 'looker.com'],
		['a look-alike', 'acme.looker.com.evil.com'],
		['a different suffix without a dot', 'evillooker.com'],
		['another vendor', 'acme.example.com'],
		['an IPv4 address', '127.0.0.1'],
		['an IPv4 address under the suffix shape', '10.0.0.1.looker.com.1'],
		['a hex IPv4 address', '0x7f.1'],
		['an IPv6 address', '[::1]'],
		['localhost', 'localhost'],
		['an internal name', 'looker.internal'],
		['a leading hyphen', '-acme.looker.com'],
		['an empty label', 'acme..looker.com'],
		['a unicode name', 'acmé.looker.com'],
		['nothing', ''],
	])('refuses %s', (_name, value) => {
		expect(() => validateCustomerValue(host, value)).toThrow(CustomerValueError)
	})

	it('refuses a non-string', () => {
		expect(() => validateCustomerValue(host, undefined)).toThrow(CustomerValueError)
		expect(() => validateCustomerValue(host, 42)).toThrow(CustomerValueError)
	})

	it('with no suffix list still refuses private and loopback names', () => {
		const open: CustomerValueConfig = { ...host, hostSuffixes: undefined }
		expect(validateCustomerValue(open, 'looker.acme.com')).toBe('looker.acme.com')
		for (const bad of ['localhost', 'db.local', 'x.internal', '169.254.169.254', '10.0.0.1']) {
			expect(() => validateCustomerValue(open, bad)).toThrow(CustomerValueError)
		}
	})

	it('names the field and never echoes the value', () => {
		try {
			validateCustomerValue(host, 'https://secret-host.example.com/x')
			throw new Error('should have thrown')
		} catch (err) {
			expect((err as Error).message).toContain('Looker address')
			expect((err as Error).message).not.toContain('secret-host')
		}
	})
})

describe('validateCustomerValue (tenant)', () => {
	it('accepts a GUID and a domain', () => {
		expect(validateCustomerValue(tenant, '11111111-2222-3333-4444-555555555555')).toBe(
			'11111111-2222-3333-4444-555555555555',
		)
		expect(validateCustomerValue(tenant, 'Contoso.onmicrosoft.com')).toBe('contoso.onmicrosoft.com')
	})

	it.each([
		['a path', '11111111-2222-3333-4444-555555555555/../x'],
		['a query', 'contoso.com?x=1'],
		['a scheme', 'https://contoso.com'],
		['a single word', 'common'],
		['an IP address', '10.0.0.1'],
		['an internal name', 'corp.internal'],
		['nothing', ' '],
	])('refuses %s', (_name, value) => {
		expect(() => validateCustomerValue(tenant, value)).toThrow(CustomerValueError)
	})
})

describe('fillCustomerValue', () => {
	it('puts the checked value in every place it is wanted', () => {
		expect(fillCustomerValue('https://{value}/auth?h={value}', host, 'Acme.looker.com')).toBe(
			'https://acme.looker.com/auth?h=acme.looker.com',
		)
	})

	it('leaves an address with no place for the value untouched, even with no value', () => {
		expect(fillCustomerValue('https://mcp.box.com', undefined, undefined)).toBe(
			'https://mcp.box.com',
		)
	})

	it('refuses to build an address without a value, or with a bad one', () => {
		expect(() => fillCustomerValue('https://{value}/auth', host, undefined)).toThrow(
			CustomerValueError,
		)
		expect(() => fillCustomerValue('https://{value}/auth', host, '169.254.169.254')).toThrow(
			CustomerValueError,
		)
	})

	it('refuses a tool that wants a value but declares none', () => {
		expect(() => fillCustomerValue('https://{value}/auth', undefined, 'a.looker.com')).toThrow()
	})
})
