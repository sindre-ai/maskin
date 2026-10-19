import { capture } from '@/lib/posthog'
import type { MarkdownParseErrorInfo } from '@maskin/markdown/react/editor'

/**
 * The one editor event. A real parse failure, a read-only open and a refused
 * rewrite all travel as editor_markdown_parse_error and differ by reason (and
 * cause or construct), so no further event name is needed. The flag ramp reads
 * parse errors where reason is not read_only_fallback.
 */
export function captureEditorParseError(info: MarkdownParseErrorInfo): void {
	capture('editor_markdown_parse_error', {
		error_message: info.errorMessage,
		variant: info.variant,
		surface: info.surface,
		object_id: info.objectId,
		reason: info.reason,
		cause: info.cause,
		construct: info.construct,
	})
}
