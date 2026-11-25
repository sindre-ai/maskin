import { describe, expect, it } from 'vitest'
import { CustomerValueError } from '../../../lib/integrations/customer-value'
import {
	assertPublicHost,
	isNonPublicAddress,
	isPrivateAddress,
} from '../../../lib/integrations/public-host'

describe('isNonPublicAddress', () => {
	it.each([
		'127.0.0.1',
		'10.1.2.3',
		'172.16.0.1',
		'172.31.255.255',
		'192.168.1.1',
		'169.254.169.254',
		'100.64.0.1',
		'0.0.0.0',
		'224.0.0.1',
		'255.255.255.255',
		'198.18.0.1',
		'::1',
		'::',
		'fe80::1',
		'fd00::1',
		'fc00::1',
		'ff02::1',
		'::ffff:127.0.0.1',
		'::ffff:a00:1',
	])('refuses %s', (address) => {
		expect(isNonPublicAddress(address)).toBe(true)
	})

	it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946'])(
		'accepts %s',
		(address) => {
			expect(isNonPublicAddress(address)).toBe(false)
		},
	)

	it('keeps the private check the extension probe already used', () => {
		expect(isPrivateAddress('10.0.0.1')).toBe(true)
		expect(isPrivateAddress('93.184.216.34')).toBe(false)
	})
})

describe('assertPublicHost', () => {
	const answer =
		(...addresses: string[]) =>
		async () =>
			addresses

	it('passes a host whose addresses are all public', async () => {
		await expect(assertPublicHost('a.looker.com', answer('93.184.216.34'))).resolves.toBeUndefined()
	})

	it('refuses a host that resolves to a private address, even next to a public one', async () => {
		await expect(assertPublicHost('a.looker.com', answer('10.0.0.1'))).rejects.toBeInstanceOf(
			CustomerValueError,
		)
		await expect(
			assertPublicHost('a.looker.com', answer('93.184.216.34', '169.254.169.254')),
		).rejects.toThrow('not reachable')
	})

	it('refuses a host that does not resolve or resolves to nothing', async () => {
		await expect(assertPublicHost('a.looker.com', answer())).rejects.toThrow("Couldn't find")
		await expect(
			assertPublicHost('a.looker.com', async () => {
				throw new Error('ENOTFOUND')
			}),
		).rejects.toThrow("Couldn't find")
	})

	it('refuses an IP literal without asking the resolver', async () => {
		let asked = false
		const resolve = async () => {
			asked = true
			return ['93.184.216.34']
		}
		await expect(assertPublicHost('127.0.0.1', resolve)).rejects.toThrow('not reachable')
		expect(asked).toBe(false)
	})
})
