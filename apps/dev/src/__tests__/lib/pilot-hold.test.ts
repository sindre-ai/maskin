import {
	PILOT_HELD_MASKIN_TOOLS,
	isPilotHeldIntegrationTool,
	isPilotHeldMaskinTool,
	validateDecisionProse,
} from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { answerOf, buildGateCard, callHash } from '../../lib/pilot-hold'

describe('callHash', () => {
	it('is the same for the same tool and arguments, whatever the key order', () => {
		expect(callHash('delete_object', { id: 'a', force: true })).toBe(
			callHash('delete_object', { force: true, id: 'a' }),
		)
	})

	it('differs when the tool or one argument differs', () => {
		const base = callHash('delete_object', { id: 'a' })
		expect(callHash('delete_file', { id: 'a' })).not.toBe(base)
		expect(callHash('delete_object', { id: 'b' })).not.toBe(base)
	})
})

describe('answerOf', () => {
	it('reads the two buttons and nothing else', () => {
		expect(answerOf('Approve')).toBe('approve')
		expect(answerOf(' Reject ')).toBe('reject')
		expect(answerOf('yes please')).toBeNull()
	})
})

describe('buildGateCard', () => {
	it('follows the decision card house style, so it renders like any other card', () => {
		const card = buildGateCard({
			agentName: 'Site editor',
			flowTitle: 'Weekly site update',
			tool: 'delete_object',
		})
		expect(validateDecisionProse(card.decision)).toEqual([])
		expect(card.content).toContain('This flow is in pilot, so sends wait for a person')
	})
})

describe('what pilot holds', () => {
	it('holds the five Maskin tools of the task', () => {
		expect([...PILOT_HELD_MASKIN_TOOLS].sort()).toEqual([
			'create_notification',
			'delete_file',
			'delete_loop',
			'delete_object',
			'delete_trigger',
		])
	})

	it('holds a tool nobody classified, and leaves a classified inside write alone', () => {
		expect(isPilotHeldMaskinTool('some_extension_tool', false)).toBe(true)
		expect(isPilotHeldMaskinTool('create_comment', true)).toBe(false)
		expect(isPilotHeldMaskinTool('delete_object', true)).toBe(true)
	})

	it('holds integration writes, but not reads or the providers that hold sends themselves', () => {
		expect(isPilotHeldIntegrationTool('google-drive', 'write')).toBe(true)
		expect(isPilotHeldIntegrationTool('github', 'write')).toBe(true)
		expect(isPilotHeldIntegrationTool('google-drive', 'read')).toBe(false)
		for (const own of ['slack', 'linkedin-unipile', 'gmail', 'resend']) {
			expect(isPilotHeldIntegrationTool(own, 'write')).toBe(false)
		}
	})
})
