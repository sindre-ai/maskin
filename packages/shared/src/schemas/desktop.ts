import { z } from 'zod'

// Agent control of the workspace desktop (see apps/agent-server/src/services/
// workspace-desktop.ts and docker/desktop-test/desktopd.py). The same schema is
// enforced twice: here at the apps/dev boundary, and again inside the VM by
// desktopd, which is the last line of defence before anything reaches xdotool.

export const DESKTOP_SCREEN_WIDTH = 1280
export const DESKTOP_SCREEN_HEIGHT = 720

const coordinate = (max: number) =>
	z
		.number()
		.int()
		.min(0)
		.max(max - 1)
const x = coordinate(DESKTOP_SCREEN_WIDTH)
const y = coordinate(DESKTOP_SCREEN_HEIGHT)

// xdotool key names ("ctrl+l", "Return", "alt+Tab", "ctrl+shift+t") — a strict
// allowlist, since these become command-line arguments.
const KEY_COMBO_RE = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/

export const desktopInputActionSchema = z.discriminatedUnion('action', [
	z.object({
		action: z.literal('click'),
		x,
		y,
		button: z.enum(['left', 'middle', 'right']).default('left'),
		double: z.boolean().default(false),
	}),
	z.object({ action: z.literal('move'), x, y }),
	z.object({
		action: z.literal('drag'),
		from_x: x,
		from_y: y,
		to_x: x,
		to_y: y,
	}),
	z.object({
		action: z.literal('scroll'),
		direction: z.enum(['up', 'down']),
		amount: z.number().int().min(1).max(20).default(3),
		x: x.optional(),
		y: y.optional(),
	}),
	z.object({ action: z.literal('type'), text: z.string().min(1).max(2000) }),
	z.object({
		action: z.literal('key'),
		keys: z
			.array(z.string().regex(KEY_COMBO_RE).max(64))
			.min(1)
			.max(20)
			.describe('Key combos pressed in order, e.g. ["ctrl+l"] or ["Tab", "Return"]'),
	}),
])
export type DesktopInputAction = z.infer<typeof desktopInputActionSchema>

export const desktopExecBodySchema = z.object({
	command: z.string().min(1).max(10_000),
	timeout_s: z.number().int().min(1).max(120).default(30),
})
export type DesktopExecBody = z.infer<typeof desktopExecBodySchema>

export const desktopExecResultSchema = z.object({
	exit_code: z.number().int().nullable(),
	stdout: z.string(),
	stderr: z.string(),
	timed_out: z.boolean(),
})
export type DesktopExecResult = z.infer<typeof desktopExecResultSchema>
