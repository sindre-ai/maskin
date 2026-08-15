import { isInlineImage } from '@/components/files/file-body'
import { useFile } from '@/hooks/use-files'
import type { FileDetail, NotificationResponse } from '@/lib/api'
import { DiffRenderer, type DiffRendererOption } from './renderers/diff-renderer'
import { MailRenderer, type MailRendererOption } from './renderers/mail-renderer'
import { MetricRenderer, type MetricRendererOption } from './renderers/metric-renderer'
import { PostRenderer, type PostRendererOption } from './renderers/post-renderer'
import {
	VisualRenderer,
	type VisualRendererMedia,
	type VisualRendererOption,
} from './renderers/visual-renderer'

// Renderer kinds the For You feed knows how to dispatch. Value must match
// `notification.metadata.artifacts[0].kind` (see `notificationArtifactSchema`
// in @maskin/shared).
export type ArtifactRendererKind = 'mail' | 'post' | 'visual' | 'metric' | 'diff'

const KNOWN_KINDS: readonly ArtifactRendererKind[] = ['mail', 'post', 'visual', 'metric', 'diff']

export function readArtifactKind(notification: NotificationResponse): ArtifactRendererKind | null {
	const metadata = (notification.metadata ?? {}) as Record<string, unknown>
	const artifacts = Array.isArray(metadata.artifacts) ? metadata.artifacts : []
	const first = artifacts[0]
	if (!first || typeof first !== 'object') return null
	const kind = (first as { kind?: unknown }).kind
	if (typeof kind !== 'string') return null
	return (KNOWN_KINDS as readonly string[]).includes(kind) ? (kind as ArtifactRendererKind) : null
}

interface OptionSource {
	label?: unknown
	value?: unknown
	description?: unknown
	default?: unknown
}

interface RendererOption {
	label: string
	value: string
	description?: string
	tone: 'primary' | 'secondary'
}

function readOptions(notification: NotificationResponse): RendererOption[] {
	const metadata = (notification.metadata ?? {}) as Record<string, unknown>
	const raw = Array.isArray(metadata.options) ? (metadata.options as OptionSource[]) : []
	const mapped: RendererOption[] = []
	for (const option of raw) {
		if (!option || typeof option !== 'object') continue
		const rawValue = typeof option.value === 'string' ? option.value : null
		const rawLabel = typeof option.label === 'string' ? option.label : null
		const value = rawValue ?? rawLabel
		const label = rawLabel ?? rawValue
		if (!value || !label) continue
		mapped.push({
			label,
			value,
			description: typeof option.description === 'string' ? option.description : undefined,
			tone: option.default === true ? 'primary' : 'secondary',
		})
	}
	return mapped
}

export interface ArtifactDecisionCardProps {
	workspaceId: string
	kind: ArtifactRendererKind
	notification: NotificationResponse
	onRespond: (response: unknown) => void
}

export function ArtifactDecisionCard({
	workspaceId,
	kind,
	notification,
	onRespond,
}: ArtifactDecisionCardProps) {
	const options = readOptions(notification)
	const commit = (option: { value: string }) => onRespond(option.value)

	switch (kind) {
		case 'mail':
			return (
				<MailRenderer
					workspaceId={workspaceId}
					notification={notification}
					options={options as MailRendererOption[]}
					onCommit={commit}
				/>
			)
		case 'post':
			return (
				<PostRenderer
					workspaceId={workspaceId}
					notification={notification}
					options={options as PostRendererOption[]}
					onCommit={commit}
				/>
			)
		case 'visual':
			return (
				<VisualArtifactRenderer
					workspaceId={workspaceId}
					notification={notification}
					options={options as VisualRendererOption[]}
					onCommit={commit}
				/>
			)
		case 'metric':
			return (
				<MetricRenderer
					workspaceId={workspaceId}
					notification={notification}
					options={options as MetricRendererOption[]}
					onCommit={commit}
				/>
			)
		case 'diff':
			return (
				<DiffRenderer
					workspaceId={workspaceId}
					notification={notification}
					options={options as DiffRendererOption[]}
					diff={readDiff(notification)}
					onCommit={commit}
				/>
			)
	}
}

function readArtifactFileId(notification: NotificationResponse): string | null {
	const metadata = (notification.metadata ?? {}) as Record<string, unknown>
	const artifacts = Array.isArray(metadata.artifacts) ? metadata.artifacts : []
	const first = artifacts[0]
	if (!first || typeof first !== 'object') return null
	const fileId = (first as { fileId?: unknown }).fileId
	return typeof fileId === 'string' && fileId ? fileId : null
}

// Turns the fetched FileDetail into the shape VisualRenderer expects. Inline-safe
// images become a base64 data URI (browsers don't send our Bearer token on
// <img src>, so the raw `file.url` viewer route won't render). Anything else —
// no fileId, still loading, or a mime type FileBody flags as unsafe (SVG,
// text/html, JS) — returns a placeholder-shaped media hint so VisualRenderer
// falls through to its icon + caption fallback.
function resolveVisualMedia(
	file: FileDetail | undefined,
	fallbackAlt: string,
): VisualRendererMedia | undefined {
	if (!file) return undefined
	const alt = file.name || fallbackAlt
	if (!isInlineImage(file.mimeType)) return { mediaType: file.mimeType, alt }
	const b64 = file.encoding === 'base64' ? file.content : btoa(file.content)
	return { src: `data:${file.mimeType};base64,${b64}`, alt, mediaType: 'image' }
}

interface VisualArtifactRendererProps {
	workspaceId: string
	notification: NotificationResponse
	options: readonly VisualRendererOption[]
	onCommit: (option: { value: string }) => void
}

function VisualArtifactRenderer({
	workspaceId,
	notification,
	options,
	onCommit,
}: VisualArtifactRendererProps) {
	const fileId = readArtifactFileId(notification)
	const { data: file } = useFile(workspaceId, fileId)
	const visual = resolveVisualMedia(file, notification.title)
	return (
		<VisualRenderer
			workspaceId={workspaceId}
			notification={notification}
			options={options}
			visual={visual}
			onCommit={onCommit}
		/>
	)
}

// The DiffRenderer requires a `diff` payload keyed off the artifact metadata.
// We surface the file path from the artifact title today; the file body
// (`lines`) is fetched by a follow-up wiring the files API into the feed, at
// which point this helper grows the fetch. Empty lines render as a
// "no visible changes" card, which is the correct placeholder until the
// body fetch lands.
function readDiff(notification: NotificationResponse) {
	const metadata = (notification.metadata ?? {}) as Record<string, unknown>
	const artifacts = Array.isArray(metadata.artifacts) ? metadata.artifacts : []
	const first = (artifacts[0] ?? {}) as { title?: unknown }
	const filePath = typeof first.title === 'string' && first.title ? first.title : notification.title
	return { filePath, lines: [] as const }
}
