import type { Annotation } from '@/components/files/annotation-overlay'

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
