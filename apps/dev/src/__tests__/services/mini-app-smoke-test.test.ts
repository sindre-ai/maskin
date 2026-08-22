import { describe, expect, it } from 'vitest'
import {
	MASKIN_APP_DATA_WINDOW_KEY,
	MASKIN_STATE_SLOT_ID,
	buildMaskinStateSlot,
} from '../../services/mini-app-regen'
import { smokeTestMiniApp } from '../../services/mini-app-smoke-test'

function appHtml(slot: string, opts?: { renderScript?: string; extraHead?: string }): string {
	const renderScript =
		opts?.renderScript ??
		`
		const state = document.getElementById('${MASKIN_STATE_SLOT_ID}').textContent;
		const parsed = JSON.parse(state);
		window.${MASKIN_APP_DATA_WINDOW_KEY} = parsed;
		const root = document.getElementById('root');
		root.textContent = 'items: ' + parsed.length;
	`
	return [
		'<!DOCTYPE html>',
		'<html lang="en">',
		'<head>',
		'<meta charset="utf-8">',
		'<title>t</title>',
		opts?.extraHead ?? '',
		'</head>',
		'<body>',
		'<div id="root"></div>',
		slot,
		`<script>${renderScript}</script>`,
		'</body>',
		'</html>',
	].join('\n')
}

describe('smokeTestMiniApp', () => {
	it('DoD — passes for a well-formed regenerated app', () => {
		const objects = [
			{ id: '11111111-1111-1111-1111-111111111111', type: 'insight', title: 'a' },
			{ id: '22222222-2222-2222-2222-222222222222', type: 'task', title: 'b' },
		]
		const html = appHtml(buildMaskinStateSlot(objects))

		const report = smokeTestMiniApp(html, {
			expectedObjectIds: objects.map((o) => o.id),
		})

		expect(report.ok).toBe(true)
		const names = report.checks.map((c) => c.name)
		expect(names).toContain('slot_present')
		expect(names).toContain('slot_is_json')
		expect(names).toContain('renders_without_error')
		expect(names).toContain('body_not_empty')
		expect(names).toContain('exposes_window_key')
		expect(names).toContain('expected_ids_present')
		expect(report.checks.every((c) => c.ok)).toBe(true)
	})

	it('DoD — fails when the maskin-state slot is missing', () => {
		const html = ['<!DOCTYPE html><html><body><div id="root"></div></body></html>'].join('')

		const report = smokeTestMiniApp(html)

		expect(report.ok).toBe(false)
		const slot = report.checks.find((c) => c.name === 'slot_present')
		expect(slot?.ok).toBe(false)
		// Kernel short-circuits — nothing downstream ran, so no render check followed.
		expect(report.checks.some((c) => c.name === 'renders_without_error')).toBe(false)
	})

	it('DoD — fails when the slot payload is not valid JSON', () => {
		const brokenSlot = `<script id="${MASKIN_STATE_SLOT_ID}" type="application/json">{ not json }</script>`
		const html = appHtml(brokenSlot)

		const report = smokeTestMiniApp(html)

		expect(report.ok).toBe(false)
		const jsonCheck = report.checks.find((c) => c.name === 'slot_is_json')
		expect(jsonCheck?.ok).toBe(false)
		expect(jsonCheck?.detail).toBeDefined()
	})

	it('DoD — flags stale slot when an expected object id is absent', () => {
		// The regenerated slot only holds one of the two ids the agent fetched —
		// that's exactly the case the check exists to catch.
		const objects = [{ id: '11111111-1111-1111-1111-111111111111', type: 'insight' }]
		const html = appHtml(buildMaskinStateSlot(objects))

		const report = smokeTestMiniApp(html, {
			expectedObjectIds: [
				'11111111-1111-1111-1111-111111111111',
				'99999999-9999-9999-9999-999999999999',
			],
		})

		expect(report.ok).toBe(false)
		const idsCheck = report.checks.find((c) => c.name === 'expected_ids_present')
		expect(idsCheck?.ok).toBe(false)
		expect(idsCheck?.detail).toContain('99999999-9999-9999-9999-999999999999')
	})

	it('DoD — fails when the render script throws', () => {
		const objects = [{ id: 'x', title: 'ok' }]
		const html = appHtml(buildMaskinStateSlot(objects), {
			// The render intentionally throws — a broken template would surface here.
			renderScript: `throw new Error('boom in render')`,
		})

		const report = smokeTestMiniApp(html)

		expect(report.ok).toBe(false)
		const render = report.checks.find((c) => c.name === 'renders_without_error')
		expect(render?.ok).toBe(false)
		expect(render?.detail).toContain('boom in render')
		const windowKey = report.checks.find((c) => c.name === 'exposes_window_key')
		expect(windowKey?.ok).toBe(false)
	})

	it('DoD — accepts many strings and nested ids in the slot payload', () => {
		// Real hosted apps often bake nested structures — the id membership
		// check must walk arrays and objects, not just the top-level list.
		const objects = {
			modules: [
				{
					id: 'mod-1',
					items: [{ id: 'obj-1' }, { id: 'obj-2' }],
				},
			],
		}
		const html = appHtml(
			`<script id="${MASKIN_STATE_SLOT_ID}" type="application/json">${JSON.stringify(objects)}</script>`,
			{
				renderScript: `
					const s = JSON.parse(document.getElementById('${MASKIN_STATE_SLOT_ID}').textContent);
					window.${MASKIN_APP_DATA_WINDOW_KEY} = s;
					document.getElementById('root').textContent = 'ok';
				`,
			},
		)

		const report = smokeTestMiniApp(html, {
			expectedObjectIds: ['obj-1', 'obj-2', 'mod-1'],
		})

		expect(report.ok).toBe(true)
	})
})
