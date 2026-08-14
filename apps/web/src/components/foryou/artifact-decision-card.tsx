import type { NotificationResponse } from '@/lib/api'
import { MailRenderer, type MailRendererOption } from './renderers/mail-renderer'
import { MetricRenderer, type MetricRendererOption } from './renderers/metric-renderer'
import { PostRenderer, type PostRendererOption } from './renderers/post-renderer'
import { VisualRenderer, type VisualRendererOption } from './renderers/visual-renderer'

// Renderer kinds the For You feed knows how to dispatch. Value must match
// `notification.metadata.artifacts[0].kind` (see `notificationArtifactSchema`
// in @maskin/shared).
//
// 'diff' is intentionally absent: T12's DiffRenderer (PR #1262) is validated
// but not yet merged into the bet branch. Once it lands, add the import, the
// literal to `KNOWN_KINDS`, and a case to the switch — the fallback in
// GroupCard already routes unknown kinds to the generic card until then.
export type ArtifactRendererKind = 'mail' | 'post' | 'visual' | 'metric'

const KNOWN_KINDS: readonly ArtifactRendererKind[] = ['mail', 'post', 'visual', 'metric']

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
	}
}
