import { describe, expect, it } from 'vitest'
import {
	DESKTOP_SCREEN_HEIGHT,
	DESKTOP_SCREEN_WIDTH,
	desktopInputActionSchema,
} from '../schemas/desktop'

describe('desktopInputActionSchema', () => {
	it('uses the native 1600x900 screen as the agent coordinate space', () => {
		expect(DESKTOP_SCREEN_WIDTH).toBe(1600)
		expect(DESKTOP_SCREEN_HEIGHT).toBe(900)
	})

	it('accepts every native pixel, corner to corner', () => {
		for (const [x, y] of [
			[0, 0],
			[1279, 719],
			[1599, 899],
		]) {
			expect(desktopInputActionSchema.safeParse({ action: 'click', x, y }).success).toBe(true)
		}
		expect(
			desktopInputActionSchema.safeParse({
				action: 'drag',
				from_x: 0,
				from_y: 0,
				to_x: 1599,
				to_y: 899,
			}).success,
		).toBe(true)
	})

	it('rejects coordinates past the native screen', () => {
		for (const [x, y] of [
			[1600, 0],
			[0, 900],
			[-1, 0],
		]) {
			expect(desktopInputActionSchema.safeParse({ action: 'click', x, y }).success).toBe(false)
		}
	})
})
