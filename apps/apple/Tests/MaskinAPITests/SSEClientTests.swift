import Testing

@testable import MaskinAPI

private actor Opens {
	private(set) var lastEventIDs: [String?] = []
	func record(_ id: String?) -> Int {
		lastEventIDs.append(id)
		return lastEventIDs.count
	}
}

private func stream(_ text: String, thenHold: Bool = false) -> AsyncThrowingStream<UInt8, Error> {
	AsyncThrowingStream { continuation in
		for byte in text.utf8 { continuation.yield(byte) }
		if !thenHold { continuation.finish() }
		// held open: never finishes, so only the silence watchdog can end it
	}
}

private let fast = SSEBackoff(initial: .milliseconds(1), max: .milliseconds(4))

/// Collect updates until `stop` says so, then cancel the stream.
private func collect(
	_ client: SSEClient, until stop: ([SSEUpdate]) -> Bool
) async -> [SSEUpdate] {
	var seen: [SSEUpdate] = []
	for await update in client.updates() {
		seen.append(update)
		if stop(seen) { break }
	}
	return seen
}

@Suite("SSEClient")
struct SSEClientTests {
	@Test("reconnects after the server closes and resumes from the last event id")
	func resumes() async {
		let opens = Opens()
		let client = SSEClient(
			open: { id in
				let n = await opens.record(id)
				return n == 1 ? stream("id: 7\nevent: created\ndata: x\n\n") : stream("", thenHold: true)
			},
			backoff: fast)

		let updates = await collect(client) { $0.filter { $0 == .connected }.count == 2 }

		#expect(updates.contains(.event(SSEEvent(id: "7", event: "created", data: "x"))))
		#expect(await opens.lastEventIDs == [nil, "7"])
	}

	@Test("a non-retryable status ends the stream with failed")
	func unauthorized() async {
		let client = SSEClient(open: { _ in throw SSEError.badStatus(401) }, backoff: fast)

		let updates = await collect(client) { _ in false }

		#expect(updates == [.failed(.badStatus(401))])
	}

	@Test("a 5xx is retried")
	func serverError() async {
		let opens = Opens()
		let client = SSEClient(
			open: { id in
				if await opens.record(id) == 1 { throw SSEError.badStatus(503) }
				return stream("", thenHold: true)
			},
			backoff: fast)

		let updates = await collect(client) { $0.contains(.connected) }

		#expect(updates.first == .disconnected(retryIn: .milliseconds(1)))
		#expect(updates.last == .connected)
	}

	@Test("recycles a connection that goes silent")
	func silence() async {
		let opens = Opens()
		let client = SSEClient(
			open: { id in
				_ = await opens.record(id)
				return stream("", thenHold: true)
			},
			backoff: fast,
			silenceTimeout: .milliseconds(40))

		let updates = await collect(client) { $0.filter { $0 == .connected }.count == 2 }

		#expect(updates.contains { if case .disconnected = $0 { true } else { false } })
	}

	@Test("heartbeat bytes keep a quiet connection alive")
	func heartbeatKeepsAlive() async throws {
		let client = SSEClient(
			open: { _ in
				AsyncThrowingStream { continuation in
					Task {
						for _ in 0..<8 {
							for byte in ": ping\n\n".utf8 { continuation.yield(byte) }
							try? await Task.sleep(for: .milliseconds(20))
						}
						continuation.finish()
					}
				}
			},
			backoff: fast,
			silenceTimeout: .milliseconds(60))

		// 160ms of pings against a 60ms watchdog: the first disconnect must be the clean close,
		// not a silence timeout, so exactly one `connected` precedes it.
		let updates = await collect(client) { u in u.contains { if case .disconnected = $0 { true } else { false } } }

		#expect(updates.filter { $0 == .connected }.count == 1)
	}

	@Test("a server that accepts, sends a byte and closes keeps backing off")
	func flappingServerBacksOff() async {
		let client = SSEClient(
			open: { _ in stream(": hi\n\n") },
			backoff: fast,
			healthyAfter: .seconds(3600))  // no connection here ever counts as healthy

		let updates = await collect(client) {
			$0.filter { if case .disconnected = $0 { true } else { false } }.count == 4
		}

		let delays = updates.compactMap { update -> Duration? in
			if case .disconnected(let d) = update { d } else { nil }
		}
		#expect(delays == [.milliseconds(1), .milliseconds(2), .milliseconds(4), .milliseconds(4)])
	}

	@Test("a connection that stayed up long enough resets the backoff")
	func healthyConnectionResets() async {
		let client = SSEClient(
			open: { _ in stream(": hi\n\n") },
			backoff: fast,
			healthyAfter: .zero)  // every connection with a byte counts as healthy

		let updates = await collect(client) {
			$0.filter { if case .disconnected = $0 { true } else { false } }.count == 3
		}

		let delays = updates.compactMap { update -> Duration? in
			if case .disconnected(let d) = update { d } else { nil }
		}
		#expect(delays == [.milliseconds(1), .milliseconds(1), .milliseconds(1)])
	}

	@Test("backoff doubles up to the cap")
	func backoffGrowth() {
		let b = SSEBackoff(initial: .seconds(1), max: .seconds(30))
		var d: Duration?
		var seen: [Duration] = []
		for _ in 0..<7 {
			d = b.next(after: d)
			seen.append(d!)
		}
		#expect(seen == [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(16), .seconds(30), .seconds(30)])
	}
}
