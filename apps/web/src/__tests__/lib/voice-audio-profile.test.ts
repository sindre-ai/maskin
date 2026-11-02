import { pickNoiseReduction } from '@/lib/voice-audio-profile'
import { describe, expect, it } from 'vitest'

const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'

describe('pickNoiseReduction', () => {
	it.each([
		'AirPods Pro',
		'Jabra Evolve Headset',
		'WH-1000XM5 Bluetooth',
		'USB Headphones',
		'Earbuds Mic',
	])('returns near_field for %s on desktop', (label) => {
		expect(pickNoiseReduction(label, DESKTOP)).toBe('near_field')
	})

	it('returns near_field on a phone whatever the label', () => {
		expect(pickNoiseReduction('', IPHONE)).toBe('near_field')
	})

	it('returns far_field for a built-in laptop mic', () => {
		expect(pickNoiseReduction('MacBook Pro Microphone', DESKTOP)).toBe('far_field')
	})

	it('returns far_field when the label is empty on desktop', () => {
		expect(pickNoiseReduction('', DESKTOP)).toBe('far_field')
	})
})
