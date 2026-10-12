import { describe, expect, it } from 'vitest'
import { LiveToolArgsError, buildLiveFunctionTools, parseLiveToolArgs } from '../function-tools'
import { liveToolLabel } from '../tool-labels'
import { LIVE_EXCLUDED_TOOLS, isClassifiedTool, toolRisk } from '../tool-risk'
import { tools } from '../tools'

const WS = '11111111-1111-4111-8111-111111111111'

describe('tool risk table', () => {
	it('classifies every MCP tool so a new tool cannot silently default to safe', () => {
		const unclassified = Object.keys(tools).filter((n) => !isClassifiedTool(n))
		expect(unclassified).toEqual([])
	})

	it('treats reads as read and destructive tools as confirm', () => {
		expect(toolRisk('search_objects')).toBe('read')
		expect(toolRisk('traverse_graph')).toBe('read')
		expect(toolRisk('delete_object')).toBe('confirm')
		expect(toolRisk('update_actor')).toBe('confirm')
		expect(toolRisk('run_agent')).toBe('confirm')
		expect(toolRisk('post_conversation_message')).toBe('confirm')
	})

	it('treats an unknown tool as confirm, never as safe', () => {
		expect(toolRisk('brand_new_tool')).toBe('confirm')
	})

	it('excludes container-only and unreadable tools', () => {
		for (const n of ['create_workspace', 'get_file', 'get_session_logs', 'connect_integration']) {
			expect(toolRisk(n)).toBe('excluded')
		}
	})

	it('escalates create_comment with high attention or mentions', () => {
		expect(toolRisk('create_comment', { content: 'x', attention: 2 })).toBe('write')
		expect(toolRisk('create_comment', { content: 'x', attention: 5 })).toBe('confirm')
		expect(toolRisk('create_comment', { content: 'x', mentions: ['a'] })).toBe('confirm')
		expect(toolRisk('create_comment', { content: 'x', mentions: [] })).toBe('write')
	})

	it('escalates create_objects outside insight, task and bet, and fails closed on odd shapes', () => {
		expect(toolRisk('create_objects', { nodes: [{ type: 'insight' }, { type: 'task' }] })).toBe(
			'write',
		)
		expect(toolRisk('create_objects', { nodes: [{ type: 'meeting' }] })).toBe('confirm')
		expect(toolRisk('create_objects', { nodes: [] })).toBe('confirm')
		expect(toolRisk('create_objects', {})).toBe('confirm')
	})

	it('escalates update_objects that move an item to a terminal status', () => {
		expect(toolRisk('update_objects', { updates: [{ id: 'a', status: 'review' }] })).toBe('write')
		expect(toolRisk('update_objects', { updates: [{ id: 'a', status: 'Done' }] })).toBe('confirm')
	})
})

describe('buildLiveFunctionTools', () => {
	const built = buildLiveFunctionTools()
	const byName = new Map(built.map((t) => [t.function.name, t]))

	it('advertises every non-excluded tool and nothing excluded', () => {
		const expected = Object.keys(tools).filter((n) => !LIVE_EXCLUDED_TOOLS.has(n))
		expect([...byName.keys()].sort()).toEqual(expected.sort())
		for (const n of LIVE_EXCLUDED_TOOLS) expect(byName.has(n)).toBe(false)
	})

	it('removes workspace_id from every schema', () => {
		for (const t of built) {
			const params = t.function.parameters as {
				properties?: Record<string, unknown>
				required?: string[]
			}
			expect(params.properties?.workspace_id).toBeUndefined()
			expect(params.required ?? []).not.toContain('workspace_id')
		}
	})

	it('produces object schemas with bounded descriptions', () => {
		for (const t of built) {
			expect((t.function.parameters as { type?: string }).type).toBe('object')
			expect(t.function.description.length).toBeLessThanOrEqual(1024)
		}
	})
})

describe('parseLiveToolArgs', () => {
	it('pins workspace_id to the live session workspace', () => {
		const args = parseLiveToolArgs('search_objects', { q: 'retries', workspace_id: 'other' }, WS)
		expect(args.workspace_id).toBe(WS)
	})

	it('rejects invalid arguments with a readable message', () => {
		expect(() => parseLiveToolArgs('get_objects', { ids: 'nope' }, WS)).toThrow(LiveToolArgsError)
	})

	it('rejects non-object arguments and unknown tools', () => {
		expect(() => parseLiveToolArgs('search_objects', null, WS)).toThrow(LiveToolArgsError)
		expect(() => parseLiveToolArgs('search_objects', [], WS)).toThrow(LiveToolArgsError)
		expect(() => parseLiveToolArgs('nope', {}, WS)).toThrow(LiveToolArgsError)
	})
})

describe('liveToolLabel', () => {
	it('never returns a tool id', () => {
		for (const n of Object.keys(tools)) expect(liveToolLabel(n)).not.toMatch(/_/)
	})
	it('falls back to neutral wording', () => {
		expect(liveToolLabel('mystery')).toBe('Working on it')
	})
})
