import { describe, expect, it } from 'vitest'
import {
	LIST_CONTRACT_ENV_VAR,
	RELEVANCE_NEEDS_Q_MESSAGE,
	conciseObjectRow,
	isListContractEnabled,
	resolveListSort,
	statusFilterParam,
} from '../list-contract'

describe('isListContractEnabled', () => {
	it('is on when the variable is unset, empty or not an off value', () => {
		expect(isListContractEnabled({})).toBe(true)
		expect(isListContractEnabled({ [LIST_CONTRACT_ENV_VAR]: '' })).toBe(true)
		expect(isListContractEnabled({ [LIST_CONTRACT_ENV_VAR]: 'on' })).toBe(true)
		expect(isListContractEnabled({ [LIST_CONTRACT_ENV_VAR]: '1' })).toBe(true)
		expect(isListContractEnabled({ [LIST_CONTRACT_ENV_VAR]: 'banana' })).toBe(true)
	})

	it.each(['0', 'false', 'off', 'no', 'disabled', ' OFF ', 'False'])('is off for %j', (value) => {
		expect(isListContractEnabled({ [LIST_CONTRACT_ENV_VAR]: value })).toBe(false)
	})
})

describe('resolveListSort', () => {
	it('defaults to created-at, newest first', () => {
		expect(resolveListSort(undefined, false)).toEqual({ apiSort: 'createdAt', order: 'desc' })
		expect(resolveListSort('created_at_desc', false)).toEqual({
			apiSort: 'createdAt',
			order: 'desc',
		})
	})

	it('maps the other four', () => {
		expect(resolveListSort('created_at_asc', false)).toEqual({ apiSort: 'createdAt', order: 'asc' })
		expect(resolveListSort('updated_at_asc', false)).toEqual({ apiSort: 'updatedAt', order: 'asc' })
		expect(resolveListSort('updated_at_desc', false)).toEqual({
			apiSort: 'updatedAt',
			order: 'desc',
		})
		expect(resolveListSort('relevance', true)).toEqual({ apiSort: 'createdAt', order: 'desc' })
	})

	it('names the fix when relevance has no q', () => {
		expect(() => resolveListSort('relevance', false)).toThrow(RELEVANCE_NEEDS_Q_MESSAGE)
		expect(RELEVANCE_NEEDS_Q_MESSAGE).toContain('Pass q')
	})
})

describe('statusFilterParam', () => {
	it('passes one status through and joins a list with commas', () => {
		expect(statusFilterParam('todo')).toBe('todo')
		expect(statusFilterParam(['todo', 'done'])).toBe('todo,done')
	})

	it('drops empties and trims, and an empty value means no filter', () => {
		expect(statusFilterParam(undefined)).toBeUndefined()
		expect(statusFilterParam([])).toBeUndefined()
		expect(statusFilterParam('')).toBeUndefined()
		expect(statusFilterParam([' todo ', '', 'done'])).toBe('todo,done')
		expect(statusFilterParam('todo, done')).toBe('todo,done')
	})
})

describe('conciseObjectRow', () => {
	it('keeps the seven fields and nothing else', () => {
		const row = conciseObjectRow({
			id: 'a',
			type: 'task',
			title: 'T',
			status: 'todo',
			driver: 'd',
			updatedAt: 'u',
			url: 'https://x',
			content: 'long body',
			metadata: { k: 1 },
			createdAt: 'c',
		})
		expect(row).toEqual({
			id: 'a',
			type: 'task',
			title: 'T',
			status: 'todo',
			driver: 'd',
			updatedAt: 'u',
			url: 'https://x',
		})
	})

	it('gives a null driver for an unowned object', () => {
		expect(conciseObjectRow({ id: 'a' }).driver).toBeNull()
	})
})
