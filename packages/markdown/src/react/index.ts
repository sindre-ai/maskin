// Read-only surface. Zero Tiptap deps — this is the entry point safe to import
// statically from a marketing/feed/notification path. The heavier
// `<MarkdownEditor>` (Tiptap) lives at `@maskin/markdown/react/editor` and MUST
// be dynamic-imported by callers so it never bundles into a read chunk.

export { MarkdownRenderer } from './renderer'
export type {
	MarkdownRendererProps,
	MarkdownRendererSize,
	RenderCodeBlockArgs,
} from './renderer'
export { MentionedText } from './mentioned-text'
export type { MentionActor } from './mentioned-text'
