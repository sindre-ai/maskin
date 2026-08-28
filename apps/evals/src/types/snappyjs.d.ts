/**
 * snappyjs ships no types. Only `compress` is used here (remote_write bodies
 * are snappy-compressed protobuf), so the surface is declared rather than
 * pulling in an untyped `any` at the call site.
 */
declare module 'snappyjs' {
	export function compress(input: Uint8Array): Uint8Array
	export function uncompress(input: Uint8Array, maxLength?: number): Uint8Array
}
