import * as Sentry from '@sentry/node'

type Level = 'debug' | 'info' | 'warn' | 'error'

interface EmitOpts {
	// Set when the caller already reported this error to Sentry directly
	// (e.g. Sentry.captureException with the real Error object, which groups
	// and displays far better than a message-only capture) — skips the
	// automatic captureMessage below so the same failure isn't double-reported.
	skipSentry?: boolean
}

function emit(level: Level, msg: string, ctx?: Record<string, unknown>, opts?: EmitOpts): void {
	const line = ctx
		? JSON.stringify({ level, time: new Date().toISOString(), msg, ...ctx })
		: JSON.stringify({ level, time: new Date().toISOString(), msg })
	if (level === 'error' || level === 'warn') {
		process.stderr.write(`${line}\n`)
	} else {
		process.stdout.write(`${line}\n`)
	}
	if (level === 'error') {
		if (!opts?.skipSentry) Sentry.captureMessage(msg, { level: 'error', extra: ctx })
	} else if (level === 'warn') {
		Sentry.addBreadcrumb({ category: 'log', level: 'warning', message: msg, data: ctx })
	}
}

export const logger = {
	debug: (msg: string, ctx?: Record<string, unknown>) => emit('debug', msg, ctx),
	info: (msg: string, ctx?: Record<string, unknown>) => emit('info', msg, ctx),
	warn: (msg: string, ctx?: Record<string, unknown>) => emit('warn', msg, ctx),
	error: (msg: string, ctx?: Record<string, unknown>, opts?: EmitOpts) =>
		emit('error', msg, ctx, opts),
}
