import { describe, expect, it } from 'vitest'
import {
	DESKTOP_SCREEN_HEIGHT,
	DESKTOP_SCREEN_WIDTH,
	desktopInputActionSchema,
} from '../schemas/desktop'

describe('desktopInputActionSchema', () => {
	it('uses the native 1920x1080 screen as the agent coordinate space', () => {
		expect(DESKTOP_SCREEN_WIDTH).toBe(1920)
		expect(DESKTOP_SCREEN_HEIGHT).toBe(1080)
	})

	it('accepts every native pixel, corner to corner', () => {
		for (const [x, y] of [
			[0, 0],
			[1279, 719],
			[1919, 1079],
		]) {
			expect(desktopInputActionSchema.safeParse({ action: 'click', x, y }).success).toBe(true)
		}
		expect(
			desktopInputActionSchema.safeParse({
				action: 'drag',
				from_x: 0,
				from_y: 0,
				to_x: 1919,
				to_y: 1079,
			}).success,
		).toBe(true)
	})

	it('rejects coordinates past the native screen', () => {
		for (const [x, y] of [
			[1920, 0],
			[0, 1080],
			[-1, 0],
		]) {
			expect(desktopInputActionSchema.safeParse({ action: 'click', x, y }).success).toBe(false)
		}
	})
})
