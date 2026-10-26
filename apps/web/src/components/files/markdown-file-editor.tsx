import { EditorBanner } from '@/components/shared/editor-banner'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { Button } from '@/components/ui/button'
import { type FileSaveClient, useMarkdownFileSave } from '@/hooks/use-markdown-file-save'
import { trackEvent } from '@/lib/analytics'
import { captureEditorParseError } from '@/lib/editor-events'
import { textCommentCardId, useTextComments } from '@/lib/text-comments-context'
import type {
	CommentRequest,
	MarkdownEditorRef,
	MarkdownParseErrorInfo,
	TextCommentHighlight,
} from '@maskin/markdown/react/editor'
import { Check } from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SourceView, type ViewMode, ViewToggle } from './file-body'
import { TextCommentCompose } from './text-comment-compose'

// Dynamic-imported so Tiptap never bundles into a read-only route (same split
// as MarkdownContent; the Vite chunk-name CI assertion enforces it). The document
// wrapper adds the slash menu, which the helper line under the file promises.
const MarkdownEditor = lazy(() =>
	import('@/components/shared/document-markdown-editor').then((m) => ({
		default: m.DocumentMarkdownEditor,
	})),
)

export const FILE_EDITOR_HELPER_LINE =
	'Edit anywhere. Type / for blocks, select text for formatting or to comment.'

export const READ_ONLY_FILE_BANNER =
	"This file is read-only here. Editing it could change parts you didn't touch."

const noop = () => undefined

// The editor mounts with the read view's typography (shared prose class), so
// Rendered looks the same before and after you start typing. Selects the editable
// root by attribute: the editor's own class name in this file would put the
// string into the main chunk, which assert-editor-chunk rejects. Direct child
// only: checklist rows hold their own contenteditable=false label.
const EDITOR_CLASS = '[&>[contenteditable]]:min-h-40 [&>[contenteditable]]:outline-none'

// The wrapper ring is the only focus cue while the file is editable: 2px
// brand-subtle inside, 3px brand outside, on a plain background (v2 File page).
const EDITOR_FOCUS_RING =
	'focus-within:bg-background focus-within:shadow-[0_0_0_2px_var(--color-brand-subtle),0_0_0_5px_var(--color-brand)]'

/** The editor's own saved form of a markdown text, for the "same as mine" check on a 409. */
async function editorSavedForm(text: string): Promise<string> {
	const { roundTrip } = await import('@maskin/markdown/roundtrip')
	return roundTrip(text)
}

export interface MarkdownFileEditorProps {
	fileId: string
	/** The file text as loaded. */
	text: string
	/** The content hash returned with the load, echoed as if_match on every save. */
	hash: string
	client: FileSaveClient
	/** False for viewers: they get the rendered document and no editor. */
	canEdit: boolean
}

/**
 * A markdown file in the viewer: the document is the editor on the Rendered
 * tab, Source shows the plain markdown read-only. Only mounted behind the
 * rich-markdown-editor flag.
 */
export function MarkdownFileEditor({
	fileId,
	text,
	hash,
	client,
	canEdit,
}: MarkdownFileEditorProps) {
	const [mode, setMode] = useState<ViewMode>('rendered')
	const [sourceText, setSourceText] = useState(text)
	const [readOnly, setReadOnly] = useState(false)
	const [refusedConstruct, setRefusedConstruct] = useState<string | null>(null)
	const editorRef = useRef<MarkdownEditorRef>(null)

	// Comments on selected text, when the file route provides them. The editor
	// only draws the highlights and offers the Comment action; the comments
	// themselves live in the route and the review panel.
	const textComments = useTextComments()
	const [compose, setCompose] = useState<CommentRequest | null>(null)
	const savedHighlights = textComments?.highlights
	const highlights = useMemo<TextCommentHighlight[] | undefined>(() => {
		if (!savedHighlights) return undefined
		if (!compose) return savedHighlights
		// The passage being commented on stays marked while the compose box is open.
		return [...savedHighlights, { id: 'pending', anchor: compose.anchor, pending: true }]
	}, [savedHighlights, compose])
	const handleCommentRequest = useCallback((request: CommentRequest) => setCompose(request), [])
	const scrollRequest = textComments?.scrollRequest
	useEffect(() => {
		if (scrollRequest) {
			editorRef.current?.scrollToTextComment(scrollRequest.id, { focus: scrollRequest.focus })
		}
	}, [scrollRequest])

	const save = useMarkdownFileSave({
		client,
		initialText: text,
		initialHash: hash,
		readText: () => editorRef.current?.getMarkdown() ?? text,
		savedForm: editorSavedForm,
		onConflictShown: () =>
			trackEvent('editor_conflict_shown', {
				surface: 'file',
				entity_id: fileId,
				entity_type: 'file',
			}),
	})

	const handleParseError = useCallback((info: MarkdownParseErrorInfo) => {
		captureEditorParseError(info)
		if (info.reason === 'read_only_fallback') setReadOnly(true)
		if (info.reason === 'loss_check') setRefusedConstruct(info.construct ?? 'unknown')
	}, [])

	const handleModeChange = useCallback(
		(next: ViewMode) => {
			if (next === 'source') setSourceText(editorRef.current?.getMarkdown() ?? text)
			setMode(next)
		},
		[text],
	)

	// Viewers (and anyone whose role is not known yet) get the rendered document.
	if (!canEdit) {
		return (
			<div className="space-y-3">
				<div className="flex justify-end">
					<ViewToggle mode={mode} onChange={setMode} />
				</div>
				{mode === 'rendered' ? <MarkdownContent content={text} /> : <SourceView text={text} />}
			</div>
		)
	}

	const showSaved = save.showSaved && !readOnly

	return (
		<div className="space-y-3">
			{compose && textComments && (
				<TextCommentCompose
					request={compose}
					onSave={(body) => {
						textComments.onCompose({ anchor: compose.anchor, position: compose.position, body })
						setCompose(null)
					}}
					onDiscard={() => {
						setCompose(null)
						editorRef.current?.focus()
					}}
				/>
			)}
			<div className="flex items-center justify-end gap-2">
				{showSaved && (
					<span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
						<Check size={14} /> Saved
					</span>
				)}
				<ViewToggle mode={mode} onChange={handleModeChange} />
			</div>

			{mode === 'source' && <SourceView text={sourceText} />}

			{/* The editor stays mounted behind the Source tab so edits, undo history
			    and the caret are not lost by looking at the source. */}
			<div className={mode === 'rendered' ? 'space-y-3' : 'hidden'}>
				{readOnly && <EditorBanner tone="info">{READ_ONLY_FILE_BANNER}</EditorBanner>}

				{save.status === 'conflict' && (
					<EditorBanner
						tone="danger"
						heading="This file changed while you were editing"
						actions={
							<>
								<Button type="button" size="sm" onClick={save.loadNewVersion}>
									Load the new version
								</Button>
								<Button type="button" variant="ghost" size="sm" onClick={save.copyMine}>
									Copy my version
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="text-destructive hover:bg-destructive/10 hover:text-destructive"
									onClick={save.keepMineAndOverwrite}
								>
									Keep mine and overwrite
								</Button>
							</>
						}
					>
						An agent or teammate saved a newer version. Your edits are not saved yet.
					</EditorBanner>
				)}

				{save.status === 'failed' && (
					<EditorBanner
						tone="danger"
						heading="Couldn't save your changes"
						actions={
							<Button type="button" size="sm" onClick={save.retry}>
								Retry
							</Button>
						}
					>
						Network error. Your draft is preserved locally.
					</EditorBanner>
				)}

				{refusedConstruct && save.status === 'idle' && (
					<EditorBanner tone="danger" heading="Couldn't save your changes">
						Part of this file can't be saved without losing something, so that part was left as it
						was. Your other changes are saved.
					</EditorBanner>
				)}

				<div className={readOnly ? undefined : `rounded-lg px-2 py-1.5 ${EDITOR_FOCUS_RING}`}>
					<Suspense fallback={<MarkdownContent content={save.baseText} />}>
						<MarkdownEditor
							key={save.editorKey}
							ref={editorRef}
							value={save.baseText}
							preserveSource
							variant="document"
							className={EDITOR_CLASS}
							surface="file"
							objectId={fileId}
							onChange={noop}
							onEdit={save.markEdited}
							onParseError={handleParseError}
							textComments={highlights}
							activeTextCommentId={textComments?.activeId ?? null}
							onTextCommentRequest={textComments ? handleCommentRequest : undefined}
							onTextCommentClick={textComments?.onHighlightClick}
							onTextCommentsOrphaned={textComments?.onOrphansChange}
							textCommentDescribedBy={textCommentCardId}
						/>
					</Suspense>
				</div>

				{!readOnly && <p className="text-xs text-muted-foreground">{FILE_EDITOR_HELPER_LINE}</p>}
			</div>
		</div>
	)
}
