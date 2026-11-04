import {
	__resetLinkedInMcpRegistryForTests,
	registerLinkedInMcpInstance,
} from '@maskin/mcp/linkedin'
import { afterEach, describe, expect, it } from 'vitest'
import {
	coerceIsSender,
	decideDirection,
	readOwnLinkedinIds,
	stripLinkedinUrnPrefix,
} from '../../../../../lib/integrations/providers/linkedin-unipile/direction'

afterEach(() => {
	__resetLinkedInMcpRegistryForTests()
})

describe('coerceIsSender', () => {
	it.each([
		[true, true],
		[false, false],
		[1, true],
		[0, false],
		[undefined, null],
		[null, null],
		['1', null],
		['true', null],
		[2, null],
	])('reads %j as %j', (input, expected) => {
		expect(coerceIsSender(input)).toBe(expected)
	})
})

describe('stripLinkedinUrnPrefix', () => {
	it('strips person and organization prefixes and leaves bare ids alone', () => {
		expect(stripLinkedinUrnPrefix('urn:li:person:ACoAAabc')).toBe('ACoAAabc')
		expect(stripLinkedinUrnPrefix('urn:li:organization:123')).toBe('123')
		expect(stripLinkedinUrnPrefix('ACoAAabc')).toBe('ACoAAabc')
	})
})

describe('decideDirection', () => {
	const own = new Set(['ACoAAown'])
	const none = new Set<string>()

	it('drops is_sender true as own_message', () => {
		expect(decideDirection({ isSender: true, senderId: 'x', ownIds: none })).toEqual({
			kind: 'drop',
			reason: 'own_message',
			source: 'is_sender',
		})
		expect(decideDirection({ isSender: 1, senderId: null, ownIds: none })).toMatchObject({
			reason: 'own_message',
		})
	})

	it('treats is_sender false as inbound when the sender is not ours', () => {
		expect(decideDirection({ isSender: false, senderId: 'ACoAAother', ownIds: own })).toEqual({
			kind: 'inbound',
			source: 'is_sender',
		})
		expect(decideDirection({ isSender: 0, senderId: 'ACoAAother', ownIds: none })).toEqual({
			kind: 'inbound',
			source: 'is_sender',
		})
	})

	it('drops is_sender false from an own id as direction_conflict, prefix-insensitive', () => {
		expect(
			decideDirection({ isSender: false, senderId: 'urn:li:person:ACoAAown', ownIds: own }),
		).toEqual({ kind: 'drop', reason: 'direction_conflict', source: 'is_sender' })
	})

	it('drops direction_unknown when is_sender is absent and the registry is empty', () => {
		expect(decideDirection({ isSender: undefined, senderId: 'ACoAAother', ownIds: none })).toEqual({
			kind: 'drop',
			reason: 'direction_unknown',
			source: 'sender_id_fallback',
		})
	})

	it('falls back to the registry when is_sender is absent and it holds own ids', () => {
		expect(decideDirection({ isSender: undefined, senderId: 'ACoAAown', ownIds: own })).toEqual({
			kind: 'drop',
			reason: 'own_message',
			source: 'sender_id_fallback',
		})
		expect(decideDirection({ isSender: undefined, senderId: 'ACoAAother', ownIds: own })).toEqual({
			kind: 'inbound',
			source: 'sender_id_fallback',
		})
	})

	it('drops direction_unknown when both is_sender and sender id are absent', () => {
		expect(decideDirection({ isSender: undefined, senderId: null, ownIds: own })).toMatchObject({
			reason: 'direction_unknown',
		})
	})
})

describe('readOwnLinkedinIds', () => {
	it('is empty when the registry holds nothing for the integration', () => {
		expect(readOwnLinkedinIds('integration-x').size).toBe(0)
	})

	it('returns the prefix-stripped identity urns registered for the integration', () => {
		registerLinkedInMcpInstance({
			workspaceId: 'w',
			actorId: 'a',
			integrationId: 'integration-x',
			unipileAccountId: 'acc',
			unipileAccSlug: 'slug',
			identityType: 'personal',
			identityUrn: 'urn:li:person:ACoAAown',
			identitySlug: 'personal',
			displayName: 'Me',
			mailboxId: null,
			messagingEnabled: true,
		})
		expect([...readOwnLinkedinIds('integration-x')]).toEqual(['ACoAAown'])
		expect(readOwnLinkedinIds('integration-y').size).toBe(0)
	})
})
