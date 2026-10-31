import chatSource from '@/components/chat/chat.tsx?raw'
import messageBubbleSource from '@/components/chat/message-bubble.tsx?raw'
import loopUtteranceInputSource from '@/components/loops/loop-utterance-input.tsx?raw'
import objectDocumentSource from '@/components/objects/object-document.tsx?raw'
import notificationInputSource from '@/components/pulse/notification-input.tsx?raw'
import pulseCardSource from '@/components/pulse/pulse-card.tsx?raw'
import { describe, expect, it } from 'vitest'

// Tech spec section 1, "Deliberately NOT swapped": the rich editor never mounts
// on these inputs. The mounts
// that do swap are asserted in their own component tests.
const EDITOR_REFERENCES = [
	'MarkdownEditor',
	'DocumentMarkdownEditor',
	'@maskin/markdown/react/editor',
]

function expectNoEditor(source: string) {
	for (const reference of EDITOR_REFERENCES) {
		expect(source, `unexpected reference to ${reference}`).not.toContain(reference)
	}
}

describe('surfaces that stay on a plain input', () => {
	it('chat composer stays on its textarea', () => {
		expectNoEditor(chatSource)
		expect(chatSource).toContain('<Textarea')
	})

	it('edit-own-message in a chat bubble uses the edit card, not the rich editor', () => {
		expectNoEditor(messageBubbleSource)
		expect(messageBubbleSource).toContain('<EditMessageCard')
		// The bubble body is a read surface: MarkdownContent without editable.
		expect(messageBubbleSource).not.toMatch(/<MarkdownContent[^>]*\beditable\b/)
	})

	it('pulse card inline reply stays on its single-line input', () => {
		expectNoEditor(pulseCardSource)
		expect(pulseCardSource).toContain('<Input')
	})

	it('loop utterance input stays plain text', () => {
		expectNoEditor(loopUtteranceInputSource)
		expect(loopUtteranceInputSource).not.toContain('MarkdownContent')
	})

	it('object title stays on its autosizing textarea', () => {
		expect(objectDocumentSource).toContain('placeholder="Untitled"')
		expect(objectDocumentSource).toMatch(/<textarea[^>]*value=\{titleDraft\}/)
		expect(objectDocumentSource).not.toContain('MarkdownEditor')
	})

	it('notification input swaps the multiline branch only', () => {
		// The single-line Input is covered by a render test (no editor).
		expect(notificationInputSource).toContain('<Input')
		expect(notificationInputSource.match(/<MarkdownEditor/g)).toHaveLength(1)
		expect(notificationInputSource).toContain('(metadata.multiline as boolean) ?')
	})
})
