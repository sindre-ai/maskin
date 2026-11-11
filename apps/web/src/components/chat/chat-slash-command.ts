import { createSlashMenuView } from '@/components/shared/slash-menu'
import { editorTelemetry } from '@/lib/editor-events'
import type { ComposerSlashMenu } from '@maskin/markdown/react/composer'

// The look and the usage event of the chat message box's slash menu. The items live in
// @maskin/markdown (buildChatSlashItems). Loaded next to the box, so cmdk stays out of the main chunk.
export const chatSlashMenu: Pick<ComposerSlashMenu, 'createView' | 'onCommandUsed'> = {
	createView: createSlashMenuView,
	onCommandUsed: (commandId) =>
		editorTelemetry({ variant: 'notification', surface: 'chat-composer' }).emitSlashCommand({
			commandId,
		}),
}
