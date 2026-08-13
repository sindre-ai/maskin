export class EmailSendError extends Error {
	readonly name = 'EmailSendError'
	readonly providerCode: string
	readonly cause: unknown

	constructor(providerCode: string, message: string, cause?: unknown) {
		super(message)
		this.providerCode = providerCode
		this.cause = cause
	}
}
