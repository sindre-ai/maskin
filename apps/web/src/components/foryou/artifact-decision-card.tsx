import type { NotificationResponse } from '@/lib/api'
import { DiffRenderer, type DiffRendererOption } from './renderers/diff-renderer'
import { MailRenderer, type MailRendererOption } from './renderers/mail-renderer'
import { MetricRenderer, type MetricRendererOption } from './renderers/metric-renderer'
import { PostRenderer, type PostRendererOption } from './renderers/post-renderer'
import { VisualRenderer, type VisualRendererOption } from './renderers/visual-renderer'

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
				<VisualRenderer
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
