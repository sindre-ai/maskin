type LogFields = Record<string, unknown>

function emit(level: 'info' | 'warn' | 'error', message: string, fields?: LogFields): void {
	const line = {
		t: new Date().toISOString(),
		level,
		msg: message,
		...(fields ?? {}),
	}
	const stream = level === 'error' ? process.stderr : process.stdout
	stream.write(`${JSON.stringify(line)}\n`)
}

export const logger = {
	info(message: string, fields?: LogFields): void {
		emit('info', message, fields)
	},
	warn(message: string, fields?: LogFields): void {
		emit('warn', message, fields)
	},
	error(message: string, fields?: LogFields): void {
		emit('error', message, fields)
	},
}
