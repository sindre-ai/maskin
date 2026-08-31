// Shared PostHog emit helper for the five editor events (tech spec §11):
// `editor_slash_command_used`, `editor_toolbar_action_used`,
// `editor_shortcut_used`, `editor_saved`, `editor_markdown_parse_error`.
//
// The helper takes `capture` as a dependency so `packages/markdown` does not
// carry a runtime dep on `posthog-js` — that would drag PostHog into every
// reader chunk and defeat the bundle split (spec §12 rabbit hole #6).
// Consumers (apps/web) inject the `capture` from their own posthog client.

/**
 * Which editor surface the event was fired from — matches the `variant` prop on
 * `<MarkdownEditor>`. Duplicated as a string literal here so this module has
 * zero import cycle with `./editor` and can be safely imported from the
 * read-only `@maskin/markdown/react` entry point.
 */
export type EditorVariant = 'document' | 'comment' | 'notification'

export type SaveTrigger = 'blur' | 'submit'

/** Truncation ceiling for `error_message` — matches `editor.tsx`'s existing rule. */
const MAX_ERROR_MESSAGE_LENGTH = 500

function truncateErrorMessage(msg: string): string {
	return msg.length > MAX_ERROR_MESSAGE_LENGTH ? `${msg.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : msg
}

/** Signature of the injected posthog `capture` function. */
export type EditorTelemetryCapture = (event: string, properties: Record<string, unknown>) => void

export interface EditorTelemetryContext {
	capture: EditorTelemetryCapture
	variant: EditorVariant
	/** Object type (e.g. 'bet') or the fixed strings 'comment' / 'notification'. */
	surface: string | undefined
	objectId: string | undefined
	/**
	 * Resolver called at emit time. Consumers should return
	 * `posthog.get_session_id()` — do not invent a new session id.
	 * Only `editor_slash_command_used` reads this; the other four events do
	 * not carry `session_id`.
	 */
	getSessionId?: () => string | undefined
}

export interface SlashCommandEmitInput {
	commandId: string
}

export interface ToolbarActionEmitInput {
	action: string
}

export interface ShortcutEmitInput {
	shortcut: string
}

export interface SavedEmitInput {
	contentLength: number
	saveTrigger: SaveTrigger
}

export interface ParseErrorEmitInput {
	errorMessage: string
}

export interface EditorTelemetryEmitters {
	emitSlashCommand: (input: SlashCommandEmitInput) => void
	emitToolbarAction: (input: ToolbarActionEmitInput) => void
	emitShortcut: (input: ShortcutEmitInput) => void
	emitSaved: (input: SavedEmitInput) => void
	emitParseError: (input: ParseErrorEmitInput) => void
}

/**
 * Build the five bound emit functions. Property extraction lives here so
 * Task 2 (slash menu) and Task 3 (toolbar + shortcuts) do not each re-derive
 * the `variant` / `surface` / `object_id` shape.
 *
 * The emitters swallow errors from `capture` — analytics must never break the
 * editor. Individual events never fire per keystroke; call sites gate on
 * discrete user actions (slash pick, toolbar click, keybinding, blur, one
 * parse-error per mount).
 */
export function createEditorTelemetry(ctx: EditorTelemetryContext): EditorTelemetryEmitters {
	const { capture, variant, surface, objectId, getSessionId } = ctx

	const safeCapture = (event: string, properties: Record<string, unknown>) => {
		try {
			capture(event, properties)
		} catch {
			// Analytics must never break the UI.
		}
	}

	return {
		emitSlashCommand: ({ commandId }) => {
			safeCapture('editor_slash_command_used', {
				command_id: commandId,
				variant,
				surface,
				object_id: objectId,
				session_id: getSessionId?.(),
			})
		},
		emitToolbarAction: ({ action }) => {
			safeCapture('editor_toolbar_action_used', {
				action,
				variant,
				surface,
				object_id: objectId,
			})
		},
		emitShortcut: ({ shortcut }) => {
			safeCapture('editor_shortcut_used', {
				shortcut,
				variant,
				surface,
			})
		},
		emitSaved: ({ contentLength, saveTrigger }) => {
			safeCapture('editor_saved', {
				variant,
				surface,
				object_id: objectId,
				content_length: contentLength,
				save_trigger: saveTrigger,
			})
		},
		emitParseError: ({ errorMessage }) => {
			safeCapture('editor_markdown_parse_error', {
				error_message: truncateErrorMessage(errorMessage),
				variant,
				surface,
				object_id: objectId,
			})
		},
	}
}
