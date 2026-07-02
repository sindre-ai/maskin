import { AnnotationOverlay } from '@/components/files/annotation-overlay'
import { render } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

function renderOverlay(onChange = vi.fn()) {
	render(
		<AnnotationOverlay
			html="<p>test</p>"
			name="test.html"
			annotations={[]}
			onAnnotationsChange={onChange}
		/>,
	)
	return onChange
}

describe('AnnotationOverlay postMessage origin guard', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('drops messages from real (non-null) origins — cross-origin forgery attempt', () => {
		const onChange = renderOverlay()
		window.dispatchEvent(
			new MessageEvent('message', {
				data: {
					type: 'MASKIN_ELEMENT_RESULT',
					id: 'forge',
					selector: '#evil',
					bounds: { x: 0, y: 0, w: 1, h: 1 },
				},
				origin: 'https://evil.com',
			}),
		)
		expect(onChange).not.toHaveBeenCalled()
	})

	it('drops null-origin messages from a source other than the sandboxed iframe', () => {
		const onChange = renderOverlay()
		// origin passes ('null') but source is the parent window, not the iframe contentWindow
		window.dispatchEvent(
			new MessageEvent('message', {
				data: {
					type: 'MASKIN_ELEMENT_RESULT',
					id: 'forge',
					selector: '#forge',
					bounds: { x: 0, y: 0, w: 1, h: 1 },
				},
				origin: 'null',
				source: window,
			}),
		)
		expect(onChange).not.toHaveBeenCalled()
	})
})
