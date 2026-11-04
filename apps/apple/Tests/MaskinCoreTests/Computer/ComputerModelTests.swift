import Foundation
import Testing

@testable import MaskinCore

/// Hands out a new ticket per call, or fails, and counts the calls.
private final class FakeConnector: DesktopConnecting, @unchecked Sendable {
	private let lock = NSLock()
	private var calls = 0
	private var failure: DesktopConnectError?
	private var delayNanos: UInt64 = 0

	var callCount: Int { lock.withLock { calls } }
	func fail(with error: DesktopConnectError?) { lock.withLock { failure = error } }
	func delay(_ nanos: UInt64) { lock.withLock { delayNanos = nanos } }

	func connect(agentID: String?) async throws -> DesktopTicket {
		let (n, failure, delay) = lock.withLock { () -> (Int, DesktopConnectError?, UInt64) in
			calls += 1
			return (calls, self.failure, delayNanos)
		}
		if delay > 0 { try await Task.sleep(nanoseconds: delay) }
		if let failure { throw failure }
		return DesktopTicket(ticket: "t\(n)", path: "/api/desktop/stream", password: "pw")
	}
}

@MainActor
private func settle(_ condition: () -> Bool) async {
	for _ in 0..<2000 where !condition() { await Task.yield() }
}

@MainActor
@Suite("ComputerModel")
struct ComputerModelTests {
	private let base = URL(string: "https://maskin.io")!

	private func model(_ connector: FakeConnector) -> ComputerModel {
		ComputerModel(agentID: "agent-1", baseURL: base, connector: connector)
	}

	@Test("opening goes Starting, then Connecting with a stream, then Live")
	func opens() async {
		let connector = FakeConnector()
		let m = model(connector)
		#expect(m.phase == .starting)
		m.startIfNeeded()
		await settle { m.stream != nil }
		#expect(m.phase == .connecting)
		#expect(m.stream?.url.absoluteString == "wss://maskin.io/api/desktop/stream?ticket=t1")
		m.handle(.connected)
		#expect(m.phase == .live)
		#expect(m.controlling == false)
	}

	@Test("startIfNeeded opens once")
	func opensOnce() async {
		let connector = FakeConnector()
		let m = model(connector)
		m.startIfNeeded()
		m.startIfNeeded()
		await settle { m.stream != nil }
		#expect(connector.callCount == 1)
	}

	@Test("Wake up after the stream closes asks for a fresh ticket")
	func wakeUpUsesAFreshTicket() async {
		let connector = FakeConnector()
		let m = model(connector)
		m.startIfNeeded()
		await settle { m.stream != nil }
		m.handle(.connected)
		m.handle(.disconnected)
		#expect(m.phase == .idle)
		#expect(m.stream == nil)
		m.connect()
		await settle { m.stream != nil }
		#expect(connector.callCount == 2)
		#expect(m.stream?.url.absoluteString == "wss://maskin.io/api/desktop/stream?ticket=t2")
	}

	@Test("a stream that closes before it was live is an error, not idle")
	func closedBeforeLive() async {
		let m = model(FakeConnector())
		m.startIfNeeded()
		await settle { m.stream != nil }
		m.handle(.disconnected)
		#expect(m.phase == .failed("Couldn't connect to the desktop."))
	}

	@Test("a failed connect shows the reason and Reconnect tries again")
	func failureThenReconnect() async {
		let connector = FakeConnector()
		connector.fail(with: .noCapacity)
		let m = model(connector)
		m.startIfNeeded()
		await settle { m.phase != .starting }
		#expect(m.phase == .failed(DesktopConnectError.noCapacity.message))
		connector.fail(with: nil)
		m.connect()
		await settle { m.stream != nil }
		#expect(m.phase == .connecting)
		#expect(connector.callCount == 2)
	}

	@Test("going to the background shows Idle and does not reconnect by itself")
	func background() async {
		let connector = FakeConnector()
		let m = model(connector)
		m.startIfNeeded()
		await settle { m.stream != nil }
		m.handle(.connected)
		m.setControlling(true)
		m.enteredBackground()
		#expect(m.phase == .idle)
		#expect(m.stream == nil)
		#expect(m.controlling == false)
		for _ in 0..<50 { await Task.yield() }
		#expect(connector.callCount == 1)
	}

	@Test("a ticket that arrives after the app left the foreground is dropped")
	func lateTicketAfterBackground() async {
		let connector = FakeConnector()
		connector.delay(50_000_000)
		let m = model(connector)
		m.startIfNeeded()
		m.enteredBackground()
		try? await Task.sleep(nanoseconds: 150_000_000)
		#expect(m.phase == .idle)
		#expect(m.stream == nil)
	}

	@Test("events from a stream that was already dropped are ignored")
	func staleEvents() {
		let m = model(FakeConnector())
		m.handle(.connected)
		#expect(m.phase == .starting)
	}

	@Test("taking over works only while live, and Stop controlling goes back to watching")
	func takeOver() async {
		let m = model(FakeConnector())
		m.startIfNeeded()
		await settle { m.stream != nil }
		m.setControlling(true)
		#expect(m.controlling == false)
		m.handle(.connected)
		m.setControlling(true)
		#expect(m.controlling)
		m.setControlling(false)
		#expect(m.controlling == false)
	}

	@Test("a new connection starts view-only")
	func newConnectionIsViewOnly() async {
		let m = model(FakeConnector())
		m.startIfNeeded()
		await settle { m.stream != nil }
		m.handle(.connected)
		m.setControlling(true)
		m.connect()
		#expect(m.controlling == false)
	}

	@Test("page events are read by name")
	func pageEvents() {
		#expect(ComputerPageEvent(name: "connect") == .connected)
		#expect(ComputerPageEvent(name: "disconnect") == .disconnected)
		#expect(ComputerPageEvent(name: "ready") == nil)
	}
}
