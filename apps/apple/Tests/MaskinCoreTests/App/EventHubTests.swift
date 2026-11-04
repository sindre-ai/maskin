import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

private func frame(_ id: Int, workspace: String = "w1", entity: String = "object") -> String {
	let json =
		#"{"workspace_id":"\#(workspace)","actor_id":"a","action":"updated","entity_type":"\#(entity)","entity_id":"e\#(id)","event_id":"\#(id)"}"#
	return "id: \(id)\nevent: updated\ndata: \(json)\n\n"
}

/// Each open() consumes the next scripted body; then holds open forever.
private actor Script {
	var bodies: [String]
	private(set) var opens = 0
	init(_ bodies: [String]) { self.bodies = bodies }
	/// Polls until `count` opens have happened (generous timeout, no fixed-sleep assumptions).
	func waitForOpens(_ count: Int, timeout: Duration = .seconds(15)) async -> Bool {
		var budget = PollBudget(timeout)
		while opens < count {
			try? await Task.sleep(for: .milliseconds(5))
			// The open it waits for is made from the main actor. Touch the main actor each round, so
			// a round held up there spends little of the budget (see `PollBudget`) instead of the
			// budget running out while the main actor is merely busy with other suites.
			await MainActor.run {}
			if !budget.spend() { return false }
		}
		return true
	}

	func next() -> String? {
		opens += 1
		return bodies.isEmpty ? nil : bodies.removeFirst()
	}
}

@MainActor
private func hub(_ bodies: [String], script: Script? = nil) -> (EventHub, Script) {
	let script = script ?? Script(bodies)
	let client = SSEClient(
		open: { _ in
			let body = await script.next()
			return AsyncThrowingStream { c in
				if let body { for b in body.utf8 { c.yield(b) } }
				if body != nil { c.finish() }  // nil: hold open
			}
		},
		backoff: SSEBackoff(initial: .milliseconds(1), max: .milliseconds(2)),
		silenceTimeout: .seconds(30))
	return (EventHub(client: client), script)
}

private func take(_ n: Int, from stream: AsyncStream<HubSignal>) async -> [HubSignal] {
	var out: [HubSignal] = []
	for await s in stream {
		out.append(s)
		if out.count == n { break }
	}
	return out
}

@MainActor
@Suite("EventHub")
struct EventHubTests {
	@Test("fans one event out to every subscriber")
	func fanOut() async {
		let (hub, _) = hub([frame(1)])
		let a = hub.subscribe()
		let b = hub.subscribe()
		hub.connect(workspaceId: "w1")
		let (ra, rb) = await (take(1, from: a), take(1, from: b))
		#expect(ra == rb)
		guard case .event(let e) = ra.first else { Issue.record("no event"); return }
		#expect(e.entityId == "e1")
		hub.disconnect()
	}

	@Test("emits .reconnected after a drop but not for the first connection")
	func reconnected() async {
		let (hub, _) = hub([frame(1), frame(2)])
		let stream = hub.subscribe()
		hub.connect(workspaceId: "w1")
		let got = await take(3, from: stream)
		#expect(got.count == 3)
		guard case .event(let first) = got[0], case .reconnected = got[1],
			case .event(let second) = got[2]
		else { Issue.record("unexpected order: \(got)"); return }
		#expect(first.entityId == "e1")
		#expect(second.entityId == "e2")
		hub.disconnect()
	}

	@Test("drops frames that aren't events and events for another workspace")
	func filters() async {
		let junk = "data: nope\n\n" + frame(1, workspace: "other") + frame(2)
		let (hub, _) = hub([junk])
		let stream = hub.subscribe()
		hub.connect(workspaceId: "w1")
		let got = await take(1, from: stream)
		guard case .event(let e) = got.first else { Issue.record("no event"); return }
		#expect(e.entityId == "e2")
		hub.disconnect()
	}

	@Test("connecting to the same workspace twice opens one stream; switching restarts")
	func restart() async throws {
		let script = Script([])
		let (hub, _) = hub([], script: script)
		hub.connect(workspaceId: "w1")
		#expect(await script.waitForOpens(1))
		// A repeat connect returns before creating a task, so nothing new may open. This is a
		// negative check, so it needs a short grace period; the positive waits are event-driven.
		hub.connect(workspaceId: "w1")
		try await Task.sleep(for: .milliseconds(100))
		#expect(await script.opens == 1)
		hub.connect(workspaceId: "w2")
		#expect(await script.waitForOpens(2))
		#expect(hub.workspaceId == "w2")
		hub.disconnect()
		#expect(hub.connection == .idle)
		#expect(hub.workspaceId == nil)
	}

	@Test("a rotated API key restarts the stream for the same workspace")
	func rotatedKeyRestarts() async throws {
		let script = Script([])
		let (hub, _) = hub([], script: script)
		hub.connect(workspaceId: "w1", credentialKey: "old")
		#expect(await script.waitForOpens(1))
		// Same workspace, same key: nothing new (negative check, short grace).
		hub.connect(workspaceId: "w1", credentialKey: "old")
		try await Task.sleep(for: .milliseconds(100))
		#expect(await script.opens == 1)
		// Same workspace, NEW key: the old stream carries a dead key and must be replaced.
		hub.connect(workspaceId: "w1", credentialKey: "new")
		#expect(await script.waitForOpens(2))
		hub.disconnect()
	}

	@Test("the connection after a key restart tells stores to refetch")
	func keyRestartAnnouncesTheGap() async {
		let script = Script([])
		let (hub, _) = hub([], script: script)
		hub.connect(workspaceId: "w1", credentialKey: "old")
		#expect(await script.waitForOpens(1))
		let signals = hub.subscribe()

		hub.connect(workspaceId: "w1", credentialKey: "new")  // rotated key: events may have been missed

		let first = await take(1, from: signals)
		#expect(first == [.reconnected])
		hub.disconnect()
	}

	@Test("an inert hub never connects")
	func inert() {
		let hub = EventHub(client: nil)
		hub.connect(workspaceId: "w1")
		#expect(hub.connection == .idle)
	}
}

@MainActor
@Suite("EventHub auth failure")
struct EventHubAuthTests {
	@Test("a 401 on the stream is reported so the session can end")
	func unauthorized() async {
		let client = SSEClient(
			open: { _ in throw SSEError.badStatus(401) },
			backoff: SSEBackoff(initial: .milliseconds(1), max: .milliseconds(2)))
		let hub = EventHub(client: client)
		var called = 0
		hub.onUnauthorized = { _ in called += 1 }

		hub.connect(workspaceId: "w1")
		var budget = PollBudget()
		while hub.connection != .failed, budget.spend() {
			try? await Task.sleep(for: .milliseconds(5))
		}

		#expect(hub.connection == .failed)
		#expect(hub.failure == .badStatus(401))
		#expect(called == 1)
	}

	@Test("the 401 reports the key the stream was opened with, not a later one")
	func reportsTheOpenedKey() async {
		let client = SSEClient(
			open: { _ in throw SSEError.badStatus(401) },
			backoff: SSEBackoff(initial: .milliseconds(1), max: .milliseconds(2)))
		let hub = EventHub(client: client)
		var reported: [String?] = []
		hub.onUnauthorized = { reported.append($0) }

		hub.connect(workspaceId: "w1", credentialKey: "ank_old")
		var budget = PollBudget()
		while hub.connection != .failed, budget.spend() {
			try? await Task.sleep(for: .milliseconds(5))
		}

		#expect(reported == ["ank_old"])
	}

	@Test("a 404 (workspace gone) fails without claiming the key is bad")
	func notFound() async {
		let client = SSEClient(open: { _ in throw SSEError.badStatus(404) })
		let hub = EventHub(client: client)
		var called = 0
		hub.onUnauthorized = { _ in called += 1 }
		hub.connect(workspaceId: "w1")
		var budget = PollBudget()
		while hub.connection != .failed, budget.spend() {
			try? await Task.sleep(for: .milliseconds(5))
		}
		#expect(hub.failure == .badStatus(404))
		#expect(called == 0)
	}

	@Test("a failure that isn't a credentials rejection is retried by itself")
	func retriesAfterNonAuthFailure() async {
		let opens = OpenCounter()
		let client = SSEClient(open: { _ in
			if await opens.next() == 1 { throw SSEError.badStatus(404) }
			return AsyncThrowingStream { _ in }  // holds open
		})
		let hub = EventHub(client: client, retryAfterFailure: .milliseconds(5))
		hub.connect(workspaceId: "w1")
		var budget = PollBudget()
		while hub.connection != .live, budget.spend() {
			try? await Task.sleep(for: .milliseconds(5))
		}
		#expect(hub.connection == .live)
		#expect(await opens.count == 2)
		hub.disconnect()
	}

	@Test("a 401 or 403 is final: the stream is not retried")
	func authRejectionIsFinal() async {
		for status in [401, 403] {
			let opens = OpenCounter()
			let client = SSEClient(open: { _ in
				_ = await opens.next()
				throw SSEError.badStatus(status)
			})
			let hub = EventHub(client: client, retryAfterFailure: .milliseconds(5))
			hub.connect(workspaceId: "w1")
			var budget = PollBudget()
			while hub.connection != .failed, budget.spend() {
				try? await Task.sleep(for: .milliseconds(5))
			}
			try? await Task.sleep(for: .milliseconds(100))
			#expect(await opens.count == 1)
			hub.disconnect()
		}
	}
}

private actor OpenCounter {
	private(set) var count = 0
	func next() -> Int { count += 1; return count }
}
