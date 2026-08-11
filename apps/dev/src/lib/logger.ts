import * as Sentry from '@sentry/node'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
	level: LogLevel
	msg: string
	timestamp: string
	[key: string]: unknown
}

function log(level: LogLevel, msg: string, context?: Record<string, unknown>) {
	const entry: LogEntry = {
		level,
		msg,
		timestamp: new Date().toISOString(),
		...context,
	}
	const output = JSON.stringify(entry)
	if (level === 'error') {
		console.error(output)
		Sentry.captureMessage(msg, { level: 'error', extra: context })
	} else {
		console.log(output)
		if (level === 'warn') {
			Sentry.addBreadcrumb({ category: 'log', level: 'warning', message: msg, data: context })
		}
	}
}

export const logger = {
	debug: (msg: string, ctx?: Record<string, unknown>) => log('debug', msg, ctx),
	info: (msg: string, ctx?: Record<string, unknown>) => log('info', msg, ctx),
	warn: (msg: string, ctx?: Record<string, unknown>) => log('warn', msg, ctx),
	error: (msg: string, ctx?: Record<string, unknown>) => log('error', msg, ctx),
}
