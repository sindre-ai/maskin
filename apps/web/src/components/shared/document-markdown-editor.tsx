import { createSlashMenuView } from '@/components/shared/slash-menu'
import { capture } from '@/lib/posthog'
import {
	MarkdownEditor,
	type MarkdownEditorProps,
	type MarkdownEditorRef,
} from '@maskin/markdown/react/editor'
import { SlashCommand } from '@maskin/markdown/react/slash-command'
import posthog from 'posthog-js'
import { forwardRef, useMemo } from 'react'

function currentSessionId(): string | undefined {
	try {
		return posthog.get_session_id()
	} catch {
		return undefined
	}
}

/**
 * The document-variant editor with its slash menu. Loaded lazily next to
 * `@maskin/markdown/react/editor`, so Tiptap, cmdk and the menu stay out of
 * every read-only chunk.
 */
export const DocumentMarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(
	function DocumentMarkdownEditor({ surface, objectId, extensions, ...props }, ref) {
		const mergedExtensions = useMemo(
			() => [
				...(extensions ?? []),
				SlashCommand.configure({
					createView: createSlashMenuView,
					// One call site for editor_slash_command_used. The shared emit helper from
					// the events task replaces this capture call when it lands.
					onCommandUsed: (commandId) =>
						capture('editor_slash_command_used', {
							command_id: commandId,
							variant: 'document',
							surface,
							object_id: objectId,
							session_id: currentSessionId(),
						}),
				}),
			],
			[extensions, surface, objectId],
		)
		return (
			<MarkdownEditor
				ref={ref}
				{...props}
				variant="document"
				surface={surface}
				objectId={objectId}
				extensions={mergedExtensions}
			/>
		)
	},
)
