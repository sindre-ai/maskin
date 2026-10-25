// The ws package ships no types and @types/ws is not installed; this covers only
// the client surface services/voice-realtime-call.ts uses.
declare module 'ws' {
	import { EventEmitter } from 'node:events'

	export default class WebSocket extends EventEmitter {
		constructor(url: string, options?: { headers?: Record<string, string> })
		readonly readyState: number
		send(data: string): void
		close(code?: number): void
		terminate(): void
	}
}
