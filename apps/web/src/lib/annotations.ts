import type { Annotation } from '@/components/files/annotation-overlay'
import type { FileDetail } from '@/lib/api'
import { decodeBase64Utf8 } from '@/lib/file-utils'

export interface AnnotationJson {
	annotations: Array<{
		id: string
		bounds: { x: number; y: number; w: number; h: number }
		selector?: string
		comment: string
	}>
}

export function compileAnnotations(annotations: Annotation[]): AnnotationJson {
	return {
		annotations: annotations.map(({ id, bounds, selector, comment }) => {
			const entry: AnnotationJson['annotations'][number] = { id, bounds, comment }
			if (selector) entry.selector = selector
			return entry
		}),
	}
}

const MAX_COMMENT_LENGTH = 500

export function sanitizeAnnotations(json: AnnotationJson): AnnotationJson {
	return {
		annotations: json.annotations.map((a) => ({
			...a,
			comment: a.comment
				.replace(/<[^>]*>/g, '')
				.trim()
				.slice(0, MAX_COMMENT_LENGTH),
		})),
	}
}

export function buildRevisePrompt(file: FileDetail, annotationJson: AnnotationJson): string {
	const html = file.encoding === 'utf8' ? file.content : decodeBase64Utf8(file.content)
	const safe = sanitizeAnnotations(annotationJson)
	return [
		'Revise the HTML prototype based on the pinned annotations. Each annotation references an element by CSS selector and describes the requested change — apply all of them.',
		'',
		'## Annotations',
		JSON.stringify(safe, null, 2),
		'',
		`## Current file: ${file.name}`,
		html,
	].join('\n')
}
