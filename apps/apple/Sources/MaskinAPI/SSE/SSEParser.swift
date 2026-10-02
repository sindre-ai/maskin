import Foundation

/// One dispatched server-sent event.
public struct SSEEvent: Sendable, Equatable {
	public var id: String?
	/// The `event:` field; the backend sets it to the event action (`created`, `updated`, …).
	public var event: String
	public var data: String

	public init(id: String?, event: String, data: String) {
		self.id = id
		self.event = event
		self.data = data
	}
}

/// Incremental parser for the `text/event-stream` format.
///
/// Fed bytes rather than lines because `URLSession.AsyncBytes.lines` swallows empty lines,
/// and an empty line is exactly what dispatches an event.
public struct SSEParser: Sendable {
	/// The last `id:` seen. Survives across events (per spec) so a reconnect can resume.
	public private(set) var lastEventID: String?

	private var line: [UInt8] = []
	private var sawCR = false
	private var eventType = ""
	private var data: [String] = []
	private var pendingID: String?

	public init(lastEventID: String? = nil) {
		self.lastEventID = lastEventID
	}

	public mutating func feed(_ bytes: some Sequence<UInt8>) -> [SSEEvent] {
		var out: [SSEEvent] = []
		for byte in bytes {
			if let event = feed(byte) { out.append(event) }
		}
		return out
	}

	public mutating func feed(_ byte: UInt8) -> SSEEvent? {
		// `\r\n` is one terminator; a bare `\r` or `\n` is also one.
		if byte == 0x0A {
			if sawCR {
				sawCR = false
				return nil
			}
			return endLine()
		}
		if byte == 0x0D {
			sawCR = true
			return endLine()
		}
		sawCR = false
		line.append(byte)
		return nil
	}

	private mutating func endLine() -> SSEEvent? {
		defer { line.removeAll(keepingCapacity: true) }
		if line.isEmpty { return dispatch() }
		let text = String(decoding: line, as: UTF8.self)
		if text.hasPrefix(":") { return nil }  // comment / heartbeat

		let field: String
		var value: String
		if let colon = text.firstIndex(of: ":") {
			field = String(text[..<colon])
			value = String(text[text.index(after: colon)...])
			if value.hasPrefix(" ") { value.removeFirst() }
		} else {
			field = text
			value = ""
		}

		switch field {
		case "event": eventType = value
		case "data": data.append(value)
		case "id" where !value.contains("\0"):
			pendingID = value
			lastEventID = value
		default: break  // `retry` and unknown fields are ignored; we own the backoff policy
		}
		return nil
	}

	private mutating func dispatch() -> SSEEvent? {
		defer {
			eventType = ""
			data.removeAll()
			pendingID = nil
		}
		guard !data.isEmpty else { return nil }
		return SSEEvent(
			id: pendingID ?? lastEventID,
			event: eventType.isEmpty ? "message" : eventType,
			data: data.joined(separator: "\n"))
	}
}
