import { capture } from '@/lib/posthog'
import type { MarkdownParseErrorInfo } from '@maskin/markdown/react/editor'
import { type EditorVariant, createEditorTelemetry } from '@maskin/markdown/react/telemetry'
import posthog from 'posthog-js'

function currentSessionId(): string | undefined {
	try {
		return posthog.get_session_id()
	} catch {
		return undefined
	}
}

/**
 * The five editor events, bound to the editor they came from. Every call site
 * goes through the shared helper in @maskin/markdown so the property shapes
 * live in one place; this only injects the posthog client and session id.
 */
export function editorTelemetry(ctx: {
	variant: EditorVariant
	surface: string | undefined
	// Optional: editor_shortcut_used carries no object id, so its caller has none to pass.
	objectId?: string | undefined
}) {
	return createEditorTelemetry({
		capture,
		getSessionId: currentSessionId,
		variant: ctx.variant,
		surface: ctx.surface,
		objectId: ctx.objectId,
	})
}

/**
 * The one editor event. A real parse failure, a read-only open and a refused
 * rewrite all travel as editor_markdown_parse_error and differ by reason (and
 * cause or construct), so no further event name is needed. The flag ramp reads
 * parse errors where reason is not read_only_fallback.
 */
export function captureEditorParseError(info: MarkdownParseErrorInfo): void {
	editorTelemetry(info).emitParseError(info)
}
