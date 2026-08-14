import { beforeEach, describe, expect, it } from 'vitest'

import {
	__resetObjectsViewStateForTesting,
	clearViewState,
	getViewState,
	patchViewState,
	setViewState,
} from '@/lib/objects-view-state'

describe('objects-view-state', () => {
	beforeEach(() => {
		__resetObjectsViewStateForTesting()
	})

	it('returns an empty snapshot when nothing has been written for a key', () => {
		const snap = getViewState('ws-1', 'bet')
		expect(snap).toEqual({ expandedGroupIds: {}, firstVisibleRowId: null })
	})

	it('round-trips a full snapshot through setViewState + getViewState', () => {
		setViewState('ws-1', 'bet', {
			expandedGroupIds: { 'status:active': true },
			firstVisibleRowId: 'obj-7',
		})
		expect(getViewState('ws-1', 'bet')).toEqual({
			expandedGroupIds: { 'status:active': true },
			firstVisibleRowId: 'obj-7',
		})
	})

	it('patchViewState merges without clobbering unrelated fields', () => {
		setViewState('ws-1', 'bet', {
			expandedGroupIds: { 'status:active': true },
			firstVisibleRowId: null,
		})
		patchViewState('ws-1', 'bet', { firstVisibleRowId: 'obj-42' })
		expect(getViewState('ws-1', 'bet')).toEqual({
			expandedGroupIds: { 'status:active': true },
			firstVisibleRowId: 'obj-42',
		})
	})

	it('patchViewState updates expandedGroupIds without clobbering firstVisibleRowId', () => {
		setViewState('ws-1', 'bet', {
			expandedGroupIds: { 'status:active': true },
			firstVisibleRowId: 'obj-7',
		})
		patchViewState('ws-1', 'bet', { expandedGroupIds: { 'status:done': true } })
		expect(getViewState('ws-1', 'bet')).toEqual({
			expandedGroupIds: { 'status:done': true },
			firstVisibleRowId: 'obj-7',
		})
	})

	it('keys per (workspaceId, displaySettingsKey) — the All tab and a type tab do not leak', () => {
		patchViewState('ws-1', '__all__', { firstVisibleRowId: 'all-row' })
		patchViewState('ws-1', 'bet', { firstVisibleRowId: 'bet-row' })
		expect(getViewState('ws-1', '__all__').firstVisibleRowId).toBe('all-row')
		expect(getViewState('ws-1', 'bet').firstVisibleRowId).toBe('bet-row')
	})

	it('keys per workspace — an anchor in workspace A does not restore in workspace B', () => {
		patchViewState('ws-1', 'bet', { firstVisibleRowId: 'a-row' })
		expect(getViewState('ws-2', 'bet').firstVisibleRowId).toBeNull()
	})

	it('clearViewState wipes only the specified slot', () => {
		patchViewState('ws-1', '__all__', { firstVisibleRowId: 'all-row' })
		patchViewState('ws-1', 'bet', { firstVisibleRowId: 'bet-row' })
		clearViewState('ws-1', 'bet')
		expect(getViewState('ws-1', 'bet').firstVisibleRowId).toBeNull()
		expect(getViewState('ws-1', '__all__').firstVisibleRowId).toBe('all-row')
	})
})
