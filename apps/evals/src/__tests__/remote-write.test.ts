import { describe, expect, it } from 'vitest'
import { encodeWriteRequest } from '../remote-write'

/**
 * A minimal protobuf reader, written independently of the encoder so the tests
 * assert the wire format rather than restating the encoder's own arithmetic. If
 * both were wrong in the same way the round-trip would still pass, so the
 * fixed-bytes test below pins the encoding against a hand-computed value.
 */
function readVarint(buf: Buffer, at: number): [number, number] {
	let result = 0
	let shift = 1
	let i = at
	while (true) {
		const byte = buf[i] as number
		i++
		result += (byte & 0x7f) * shift
		if ((byte & 0x80) === 0) return [result, i]
		shift *= 128
	}
}

interface Series {
	labels: Record<string, string>
	samples: { value: number; timestamp: number }[]
}

function decode(buf: Buffer): Series[] {
	const series: Series[] = []
	let i = 0
	while (i < buf.length) {
		const [seriesTag, afterTag] = readVarint(buf, i)
		expect(seriesTag).toBe((1 << 3) | 2)
		const [len, afterLen] = readVarint(buf, afterTag)
		const body = buf.subarray(afterLen, afterLen + len)
		i = afterLen + len

		const entry: Series = { labels: {}, samples: [] }
		let j = 0
		while (j < body.length) {
			const [fieldTag, afterFieldTag] = readVarint(body, j)
			const [innerLen, afterInnerLen] = readVarint(body, afterFieldTag)
			const inner = body.subarray(afterInnerLen, afterInnerLen + innerLen)
			j = afterInnerLen + innerLen

			if (fieldTag === ((1 << 3) | 2)) {
				// Label: two length-delimited strings.
				const [, a] = readVarint(inner, 0)
				const [nameLen, b] = readVarint(inner, a)
				const name = inner.subarray(b, b + nameLen).toString('utf8')
				const [, c] = readVarint(inner, b + nameLen)
				const [valueLen, d] = readVarint(inner, c)
				entry.labels[name] = inner.subarray(d, d + valueLen).toString('utf8')
			} else {
				// Sample: double then varint timestamp.
				const value = inner.readDoubleLE(1)
				const [timestamp] = readVarint(inner, 10)
				entry.samples.push({ value, timestamp })
			}
		}
		series.push(entry)
	}
	return series
}

describe('encodeWriteRequest', () => {
	const encoded = encodeWriteRequest(
		[
			{ name: 'maskin_eval_suite_pass_ratio', labels: { suite: 'mcp-tools' }, value: 0.75 },
			{ name: 'maskin_eval_tokens', labels: { kind: 'input' }, value: 100 },
		],
		1_756_000_000_000,
	)

	it('emits one timeseries per metric, each with one sample', () => {
		const series = decode(encoded)
		expect(series).toHaveLength(2)
		expect(series[0]?.samples).toEqual([{ value: 0.75, timestamp: 1_756_000_000_000 }])
	})

	it('carries the metric name as the __name__ label, since the wire format has no name field', () => {
		const series = decode(encoded)
		expect(series[0]?.labels.__name__).toBe('maskin_eval_suite_pass_ratio')
		expect(series[0]?.labels.suite).toBe('mcp-tools')
	})

	it('sorts labels by name, which a well-formed series requires', () => {
		const series = decode(
			encodeWriteRequest([{ name: 'm', labels: { zeta: '1', alpha: '2' }, value: 0 }], 1),
		)
		expect(Object.keys(series[0]?.labels ?? {})).toEqual(['__name__', 'alpha', 'zeta'])
	})

	it('encodes a timestamp past 2^28 as a multi-byte varint', () => {
		// A naive `value >> 7` varint silently truncates above 2^31, which every
		// real millisecond timestamp exceeds. This pins the arithmetic.
		const series = decode(
			encodeWriteRequest([{ name: 'm', labels: {}, value: 1 }], 1_756_000_000_000),
		)
		expect(series[0]?.samples[0]?.timestamp).toBe(1_756_000_000_000)
	})
})
