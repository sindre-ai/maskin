import Testing

@testable import MaskinAPI

@Suite("SSEParser")
struct SSEParserTests {
	private func parse(_ text: String, into parser: inout SSEParser) -> [SSEEvent] {
		parser.feed(Array(text.utf8))
	}

	@Test("dispatches id, event and data on the blank line")
	func basicEvent() {
		var parser = SSEParser()
		let events = parse("id: 12\nevent: updated\ndata: {\"a\":1}\n\n", into: &parser)
		#expect(events == [SSEEvent(id: "12", event: "updated", data: "{\"a\":1}")])
		#expect(parser.lastEventID == "12")
	}

	@Test("does not dispatch before the terminating blank line")
	func incomplete() {
		var parser = SSEParser()
		#expect(parse("event: created\ndata: x\n", into: &parser).isEmpty)
		#expect(parse("\n", into: &parser).count == 1)
	}

	@Test("joins multiple data lines with a newline")
	func multilineData() {
		var parser = SSEParser()
		let events = parse("data: one\ndata: two\n\n", into: &parser)
		#expect(events.first?.data == "one\ntwo")
	}

	@Test("treats CRLF as a single terminator")
	func crlf() {
		var parser = SSEParser()
		let events = parse("event: created\r\ndata: x\r\n\r\n", into: &parser)
		#expect(events == [SSEEvent(id: nil, event: "created", data: "x")])
	}

	@Test("produces the same events when fed one byte at a time")
	func byteByByte() {
		let wire = "id: 1\nevent: created\ndata: a\n\n: ping\n\nid: 2\ndata: b\n\n"
		var whole = SSEParser()
		let expected = parse(wire, into: &whole)

		var split = SSEParser()
		var got: [SSEEvent] = []
		for byte in wire.utf8 { if let e = split.feed(byte) { got.append(e) } }

		#expect(got == expected)
		#expect(got.count == 2)
	}

	@Test("ignores heartbeat comments")
	func heartbeat() {
		var parser = SSEParser()
		#expect(parse(": ping\n\n", into: &parser).isEmpty)
	}

	@Test("defaults the event name to message and keeps the last id when none is sent")
	func defaults() {
		var parser = SSEParser()
		let events = parse("id: 5\ndata: a\n\ndata: b\n\n", into: &parser)
		#expect(events.map(\.event) == ["message", "message"])
		#expect(events.map(\.id) == ["5", "5"])
	}

	@Test("a block with no data field is not an event")
	func noData() {
		var parser = SSEParser()
		#expect(parse("event: created\n\n", into: &parser).isEmpty)
	}

	@Test("keeps multi-byte UTF-8 intact")
	func utf8() {
		var parser = SSEParser()
		let events = parse("data: håndtér ✓\n\n", into: &parser)
		#expect(events.first?.data == "håndtér ✓")
	}
}
