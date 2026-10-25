import { createSlashMenuView } from '@/components/shared/slash-menu'
import { editorTelemetry } from '@/lib/editor-events'
import {
	MarkdownEditor,
	type MarkdownEditorProps,
	type MarkdownEditorRef,
} from '@maskin/markdown/react/editor'
import { SlashCommand } from '@maskin/markdown/react/slash-command'
import { forwardRef, useMemo } from 'react'

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
					// One call site for editor_slash_command_used.
					onCommandUsed: (commandId) =>
						editorTelemetry({ variant: 'document', surface, objectId }).emitSlashCommand({
							commandId,
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
