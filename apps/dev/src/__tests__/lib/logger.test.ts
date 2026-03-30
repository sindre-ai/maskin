import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../lib/logger'

describe('logger', () => {
	let logSpy: ReturnType<typeof vi.spyOn>
	let errorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function parseOutput(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
		const raw = spy.mock.calls[0][0] as string
		return JSON.parse(raw)
	}

	describe('info', () => {
		it('outputs JSON to console.log with correct level and msg', () => {
			logger.info('server started')
			expect(logSpy).toHaveBeenCalledOnce()

			const entry = parseOutput(logSpy)
			expect(entry.level).toBe('info')
			expect(entry.msg).toBe('server started')
		})

		it('includes a valid ISO timestamp', () => {
			logger.info('test')
			const entry = parseOutput(logSpy)
			expect(new Date(entry.timestamp as string).toISOString()).toBe(entry.timestamp)
		})

		it('includes extra context fields', () => {
			logger.info('request', { method: 'GET', path: '/api/health' })
			const entry = parseOutput(logSpy)
			expect(entry.method).toBe('GET')
			expect(entry.path).toBe('/api/health')
		})
	})

	describe('debug', () => {
		it('outputs to console.log with level debug', () => {
			logger.debug('trace info')
			expect(logSpy).toHaveBeenCalledOnce()

			const entry = parseOutput(logSpy)
			expect(entry.level).toBe('debug')
			expect(entry.msg).toBe('trace info')
		})
	})

	describe('warn', () => {
		it('outputs to console.log with level warn', () => {
			logger.warn('deprecation notice')
			expect(logSpy).toHaveBeenCalledOnce()

			const entry = parseOutput(logSpy)
			expect(entry.level).toBe('warn')
			expect(entry.msg).toBe('deprecation notice')
		})
	})

	describe('error', () => {
		it('outputs to console.error (not console.log)', () => {
			logger.error('something broke')
			expect(errorSpy).toHaveBeenCalledOnce()
			expect(logSpy).not.toHaveBeenCalled()

			const entry = parseOutput(errorSpy)
			expect(entry.level).toBe('error')
			expect(entry.msg).toBe('something broke')
		})

		it('includes context fields', () => {
			logger.error('db failed', { code: 'ECONNREFUSED', host: 'localhost' })
			const entry = parseOutput(errorSpy)
			expect(entry.code).toBe('ECONNREFUSED')
			expect(entry.host).toBe('localhost')
		})
	})
})
