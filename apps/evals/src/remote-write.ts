import type { Metric } from './report'

/**
 * Minimal Prometheus remote_write encoder.
 *
 * The payload is a snappy-compressed `prometheus.WriteRequest` protobuf. That
 * message is four fields deep and uses two wire types, so it is encoded here by
 * hand rather than pulling in protobufjs and a .proto file for it. The upside
 * is not size - it is that this file has no transitive dependency that can
 * declare a Node version above the one CI and `node:20-alpine` pin, which is a
 * failure mode this repo has already been bitten by once (see the undici/Faro
 * entry in .claude/rules/known-pitfalls.md).
 *
 *   message Label       { string name = 1; string value = 2; }
 *   message Sample      { double value = 1; int64 timestamp = 2; }
 *   message TimeSeries  { repeated Label labels = 1; repeated Sample samples = 2; }
 *   message WriteRequest { repeated TimeSeries timeseries = 1; }
 */

function varint(value: number): Buffer {
	const bytes: number[] = []
	let v = value
	while (v > 0x7f) {
		bytes.push((v & 0x7f) | 0x80)
		v = Math.floor(v / 128)
	}
	bytes.push(v)
	return Buffer.from(bytes)
}

/** Tag byte for a field: (fieldNumber << 3) | wireType. */
function tag(field: number, wireType: 0 | 1 | 2): Buffer {
	return varint((field << 3) | wireType)
}

/** Length-delimited (wire type 2) field. */
function embedded(field: number, payload: Buffer): Buffer {
	return Buffer.concat([tag(field, 2), varint(payload.length), payload])
}

function stringField(field: number, value: string): Buffer {
	return embedded(field, Buffer.from(value, 'utf8'))
}

/** double (wire type 1), little-endian. */
function doubleField(field: number, value: number): Buffer {
	const buf = Buffer.alloc(8)
	buf.writeDoubleLE(value)
	return Buffer.concat([tag(field, 1), buf])
}

/** int64 as a varint (wire type 0). Timestamps are always positive here. */
function int64Field(field: number, value: number): Buffer {
	return Buffer.concat([tag(field, 0), varint(value)])
}

/**
 * Encode metrics as a WriteRequest body.
 *
 * `__name__` is prepended as a label because that is how Prometheus carries a
 * metric name over remote_write - there is no separate name field. Labels are
 * sorted by name, which the protocol requires of a well-formed series.
 */
export function encodeWriteRequest(metrics: Metric[], timestampMs: number): Buffer {
	const series = metrics.map((metric) => {
		const labels = [['__name__', metric.name] as const, ...Object.entries(metric.labels)].sort(
			(a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
		)
		const parts = labels.map(([name, value]) =>
			embedded(1, Buffer.concat([stringField(1, name), stringField(2, value)])),
		)
		parts.push(
			embedded(2, Buffer.concat([doubleField(1, metric.value), int64Field(2, timestampMs)])),
		)
		return embedded(1, Buffer.concat(parts))
	})
	return Buffer.concat(series)
}
