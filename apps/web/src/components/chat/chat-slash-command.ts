import { createSlashMenuView } from '@/components/shared/slash-menu'
import { editorTelemetry } from '@/lib/editor-events'
import { SlashCommand, buildChatSlashItems } from '@maskin/markdown/react/slash-command'

// The slash menu for the chat message box (items live in @maskin/markdown).

/** Add it to the message box editor through its `extensions` prop. */
export function chatSlashCommand({
	attachFile,
	surface,
	objectId,
}: {
	attachFile: () => void
	surface?: string
	objectId?: string
}) {
	return SlashCommand.configure({
		createView: createSlashMenuView,
		items: buildChatSlashItems(attachFile),
		onCommandUsed: (commandId) =>
			editorTelemetry({ variant: 'notification', surface, objectId }).emitSlashCommand({
				commandId,
			}),
	})
}
