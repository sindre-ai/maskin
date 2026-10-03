import { describe, expect, it, vi } from 'vitest'
import { createEditorTelemetry } from '../../react/telemetry'

// Task 5 — the shared emit helper is the single call site for the five spec
// §11 editor events. Every event's property extraction goes through here so
// Task 2 (slash menu) and Task 3 (toolbar + shortcuts) do not each re-derive
// the `variant` / `surface` / `object_id` shape.

describe('createEditorTelemetry', () => {
	it('emits editor_slash_command_used with the exact spec §11 property set', () => {
		const capture = vi.fn()
		const getSessionId = vi.fn(() => 'sess_abc123')
		const telemetry = createEditorTelemetry({
			capture,
			variant: 'document',
			surface: 'bet',
			objectId: 'obj_42',
			getSessionId,
		})

		telemetry.emitSlashCommand({ commandId: 'heading_1' })

		expect(capture).toHaveBeenCalledTimes(1)
		expect(capture).toHaveBeenCalledWith('editor_slash_command_used', {
			command_id: 'heading_1',
			variant: 'document',
			surface: 'bet',
			object_id: 'obj_42',
			session_id: 'sess_abc123',
		})
		expect(getSessionId).toHaveBeenCalledTimes(1)
	})

	it('emits editor_slash_command_used with session_id undefined when the resolver is missing', () => {
		// Regression guard: the helper must not throw when consumers omit
		// `getSessionId` (e.g. tests, storybook, jsdom preview envs). The
		// resolver being absent is treated as "session id unknown".
		const capture = vi.fn()
		const telemetry = createEditorTelemetry({
			capture,
			variant: 'document',
			surface: 'bet',
			objectId: 'obj_42',
		})

		telemetry.emitSlashCommand({ commandId: 'bullet_list' })

		expect(capture).toHaveBeenCalledWith('editor_slash_command_used', {
			command_id: 'bullet_list',
			variant: 'document',
			surface: 'bet',
			object_id: 'obj_42',
			session_id: undefined,
		})
	})

	it('emits editor_toolbar_action_used with { action, variant, surface, object_id }', () => {
		const capture = vi.fn()
		const telemetry = createEditorTelemetry({
			capture,
			variant: 'document',
			surface: 'task',
			objectId: 'obj_task_1',
		})

		telemetry.emitToolbarAction({ action: 'bold' })

		expect(capture).toHaveBeenCalledTimes(1)
		expect(capture).toHaveBeenCalledWith('editor_toolbar_action_used', {
			action: 'bold',
			variant: 'document',
			surface: 'task',
			object_id: 'obj_task_1',
		})
	})

	it('emits editor_shortcut_used with { shortcut, variant, surface } — no object_id', () => {
		// The spec §11 shortcut row deliberately omits `object_id` and
		// `session_id`; the helper must not add either.
		const capture = vi.fn()
		const telemetry = createEditorTelemetry({
			capture,
			variant: 'document',
			surface: 'bet',
			objectId: 'obj_42',
		})

		telemetry.emitShortcut({ shortcut: 'mod+b' })

		expect(capture).toHaveBeenCalledTimes(1)
		expect(capture).toHaveBeenCalledWith('editor_shortcut_used', {
			shortcut: 'mod+b',
			variant: 'document',
			surface: 'bet',
		})
	})

	it('emits editor_saved with the blur trigger and content_length', () => {
		const capture = vi.fn()
		const telemetry = createEditorTelemetry({
			capture,
			variant: 'document',
			surface: 'bet',
			objectId: 'obj_bet_1',
		})

		telemetry.emitSaved({ contentLength: 128, saveTrigger: 'blur' })

		expect(capture).toHaveBeenCalledWith('editor_saved', {
			variant: 'document',
			surface: 'bet',
			object_id: 'obj_bet_1',
			content_length: 128,
			save_trigger: 'blur',
		})
	})

	it('emits editor_saved with the submit trigger for the comment variant when it ships', () => {
		const capture = vi.fn()
		const telemetry = createEditorTelemetry({
			capture,
			variant: 'comment',
			surface: 'comment',
			objectId: 'obj_comment_1',
		})

		telemetry.emitSaved({ contentLength: 32, saveTrigger: 'submit' })

		expect(capture).toHaveBeenCalledWith('editor_saved', {
			variant: 'comment',
			surface: 'comment',
			object_id: 'obj_comment_1',
			content_length: 32,
			save_trigger: 'submit',
		})
	})

	it('emits editor_markdown_parse_error and truncates the message at 500 chars', () => {
		const capture = vi.fn()
		const telemetry = createEditorTelemetry({
			capture,
			variant: 'document',
			surface: 'bet',
			objectId: 'obj_bet_1',
		})

		const longMessage = 'x'.repeat(600)
		telemetry.emitParseError({ errorMessage: longMessage })

		expect(capture).toHaveBeenCalledTimes(1)
		const [event, props] = vi.mocked(capture).mock.calls[0] as [string, Record<string, unknown>]
		expect(event).toBe('editor_markdown_parse_error')
		expect(props.variant).toBe('document')
		expect(props.surface).toBe('bet')
		expect(props.object_id).toBe('obj_bet_1')
		expect(typeof props.error_message).toBe('string')
		// 500 chars of `x` plus the trailing ellipsis — matches editor.tsx's
		// existing truncation rule.
		expect(props.error_message).toBe(`${'x'.repeat(500)}…`)
	})

	it('emits editor_markdown_parse_error without truncation for messages ≤500 chars', () => {
		const capture = vi.fn()
		const telemetry = createEditorTelemetry({
			capture,
			variant: 'document',
			surface: 'bet',
			objectId: 'obj_bet_1',
		})

		telemetry.emitParseError({ errorMessage: 'short error' })

		expect(capture).toHaveBeenCalledWith('editor_markdown_parse_error', {
			error_message: 'short error',
			variant: 'document',
			surface: 'bet',
			object_id: 'obj_bet_1',
		})
	})

	it('swallows errors thrown by the injected capture — analytics must never break the editor', () => {
		// Regression guard: if the posthog client throws (network stub, HMR
		// race, opt-out state), the editor must keep working. Same posture
		// as `apps/web/src/lib/posthog.ts`'s `capture()` try/catch.
		const capture = vi.fn(() => {
			throw new Error('boom')
		})
		const telemetry = createEditorTelemetry({
			capture,
			variant: 'document',
			surface: 'bet',
			objectId: 'obj_42',
		})

		expect(() => telemetry.emitToolbarAction({ action: 'italic' })).not.toThrow()
		expect(() => telemetry.emitShortcut({ shortcut: 'mod+i' })).not.toThrow()
		expect(() => telemetry.emitSaved({ contentLength: 1, saveTrigger: 'blur' })).not.toThrow()
		expect(() => telemetry.emitParseError({ errorMessage: 'x' })).not.toThrow()
		expect(() => telemetry.emitSlashCommand({ commandId: 'heading_1' })).not.toThrow()
	})

	it('carries undefined surface / objectId through when the consumer has not threaded them yet', () => {
		// Regression guard: Task 6 threads `surface` / `objectId` through the
		// consumer sites; before that flip, they are legitimately undefined
		// and must survive to PostHog rather than be replaced by empty
		// strings or a placeholder.
		const capture = vi.fn()
		const telemetry = createEditorTelemetry({
			capture,
			variant: 'document',
			surface: undefined,
			objectId: undefined,
		})

		telemetry.emitSaved({ contentLength: 10, saveTrigger: 'blur' })

		expect(capture).toHaveBeenCalledWith('editor_saved', {
			variant: 'document',
			surface: undefined,
			object_id: undefined,
			content_length: 10,
			save_trigger: 'blur',
		})
	})
})
