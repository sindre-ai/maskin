import { z } from 'zod'

// Agent control of the workspace desktop (see apps/agent-server/src/services/
// workspace-desktop.ts and docker/desktop/desktopd.py). The same schema is
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

// ─── Teach a task ──────────────────────────────────────────────────────────
// A person demonstrates a task on the shared desktop; the browser records what
// they did (an action log plus a screenshot at each step) and hands it to a
// workspace agent, which turns it into a draft skill. No video is ever made:
// frames are JPEG stills taken at the moment of each action.

export const TEACH_MAX_FRAMES = 60
export const TEACH_MAX_EVENTS = 1500
export const TEACH_MAX_DURATION_MS = 10 * 60 * 1000
// Decoded JPEG size caps: a 1280x720 frame at quality ~0.6 is typically 40-100KB.
export const TEACH_MAX_FRAME_BYTES = 400 * 1024
export const TEACH_MAX_TOTAL_FRAME_BYTES = 8 * 1024 * 1024

export const teachFrameIdSchema = z.string().regex(/^f\d{3}$/, 'frame id looks like f001')

const eventTime = z
	.number()
	.int()
	.min(0)
	.max(TEACH_MAX_DURATION_MS + 60_000)
// A frame is optional: past the frame cap events keep being logged without one.
const eventFrame = teachFrameIdSchema.optional()

export const teachEventSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('click'),
		t_ms: eventTime,
		x,
		y,
		button: z.enum(['left', 'middle', 'right']),
		double: z.boolean().default(false),
		frame: eventFrame,
	}),
	z.object({
		type: z.literal('scroll'),
		t_ms: eventTime,
		direction: z.enum(['up', 'down']),
		amount: z.number().int().min(1).max(200),
		x,
		y,
		frame: eventFrame,
	}),
	z.object({
		type: z.literal('type'),
		t_ms: eventTime,
		// Typed characters are kept as typed (including anything secret): the agent
		// is told to redact credentials, and the recording is deleted afterwards.
		text: z.string().min(1).max(4000),
		frame: eventFrame,
	}),
	z.object({
		type: z.literal('key'),
		t_ms: eventTime,
		// xdotool-style names, e.g. "ctrl+l", "Return", "Tab".
		keys: z.string().regex(KEY_COMBO_RE).max(64),
		frame: eventFrame,
	}),
])
export type TeachEvent = z.infer<typeof teachEventSchema>

export const teachFrameSchema = z.object({
	id: teachFrameIdSchema,
	t_ms: eventTime,
	// Base64 of a JPEG (no data: prefix).
	data_base64: z
		.string()
		.min(100)
		.max(Math.ceil((TEACH_MAX_FRAME_BYTES * 4) / 3) + 8),
})
export type TeachFrame = z.infer<typeof teachFrameSchema>

export const teachRequestSchema = z.object({
	agent_id: z.string().uuid(),
	description: z.string().trim().min(3).max(2000),
	duration_ms: z
		.number()
		.int()
		.min(0)
		.max(TEACH_MAX_DURATION_MS + 60_000),
	events: z.array(teachEventSchema).min(1).max(TEACH_MAX_EVENTS),
	frames: z.array(teachFrameSchema).max(TEACH_MAX_FRAMES),
	// The screen after the last action, so its effect is visible. Must be one of `frames`.
	final_frame: teachFrameIdSchema.optional(),
})
export type TeachRequest = z.infer<typeof teachRequestSchema>

export const teachResponseSchema = z.object({
	recording_id: z.string(),
	session_id: z.string().uuid(),
	agent_id: z.string().uuid(),
	frames_stored: z.number().int(),
	events_stored: z.number().int(),
})
export type TeachResponse = z.infer<typeof teachResponseSchema>
