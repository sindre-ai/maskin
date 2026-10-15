export interface Point {
	x: number
	y: number
}

export interface Size {
	w: number
	h: number
}

export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 4
export const ZOOM_STEP = 1.25

export function clampZoom(k: number): number {
	if (Number.isNaN(k)) return ZOOM_MIN
	if (k < ZOOM_MIN) return ZOOM_MIN
	if (k > ZOOM_MAX) return ZOOM_MAX
	return k
}

// Fit-to-screen: letterbox the natural document D inside the viewport V.
// `k = min(Vw/Dw, Vh/Dh)`, clamped to [ZOOM_MIN, ZOOM_MAX].
export function computeFit(doc: Size, viewport: Size): number {
	if (doc.w <= 0 || doc.h <= 0 || viewport.w <= 0 || viewport.h <= 0) {
		return ZOOM_MIN
	}
	return clampZoom(Math.min(viewport.w / doc.w, viewport.h / doc.h))
}

export function zoomStep(k: number, dir: 'in' | 'out'): number {
	return clampZoom(dir === 'in' ? k * ZOOM_STEP : k / ZOOM_STEP)
}

// Doc-space pin position (0..1 fractions of natural doc dims) → stage-space
// pixel offset above the scaled iframe: left = xDoc * Dw * k, top = yDoc * Dh * k.
export function docToStage(pointDoc: Point, doc: Size, k: number): Point {
	return { x: pointDoc.x * doc.w * k, y: pointDoc.y * doc.h * k }
}

// Inverse of docToStage. Round-trip test:
//   stageToDoc(docToStage(p, D, k), D, k) === p within 0.5px equivalent.
export function stageToDoc(pointStage: Point, doc: Size, k: number): Point {
	if (doc.w === 0 || doc.h === 0 || k === 0) return { x: 0, y: 0 }
	return { x: pointStage.x / (doc.w * k), y: pointStage.y / (doc.h * k) }
}

// Zoom-around-a-point: translate the scroll offset so `cursor` (in stage coords
// relative to the viewport top-left) stays fixed under the mouse after k changes.
// `scroll` is the current viewport scroll offset over the (D * k)-sized stage.
export interface ZoomAtResult {
	k: number
	scroll: Point
}

export function zoomAt(
	prevK: number,
	nextKUnclamped: number,
	cursor: Point,
	scroll: Point,
): ZoomAtResult {
	const nextK = clampZoom(nextKUnclamped)
	if (prevK === 0) return { k: nextK, scroll }
	const ratio = nextK / prevK
	// docPoint under cursor before zoom = (scroll + cursor) / prevK.
	// After zoom, the same doc point projects to (scroll' + cursor) / nextK.
	// Setting the two equal: scroll' = ratio * (scroll + cursor) - cursor.
	return {
		k: nextK,
		scroll: {
			x: ratio * (scroll.x + cursor.x) - cursor.x,
			y: ratio * (scroll.y + cursor.y) - cursor.y,
		},
	}
}
