import Foundation
import Testing

@testable import MaskinCore

private final class FirstLaunchClock: @unchecked Sendable {
	private let lock = NSLock()
	private var time: Date
	init(_ start: Date) { time = start }
	func advance(_ seconds: TimeInterval) { lock.withLock { time = time.addingTimeInterval(seconds) } }
	func now() -> Date { lock.withLock { time } }
}

@MainActor
@Suite("Analytics: first-launch steps")
struct FirstLaunchStepTests {
	private func make(
		storage: InMemoryAnalyticsStorage = InMemoryAnalyticsStorage(), clock: FirstLaunchClock = FirstLaunchClock(Date(timeIntervalSince1970: 1_800_000_000)),
		signedIn: Bool = true
	) -> Analytics {
		let analytics = Analytics()
		analytics.configure(
			transport: RecordingAnalyticsTransport(), storage: storage, clock: { clock.now() }, sendsOnItsOwn: false)
		if signedIn { analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1") }
		return analytics
	}

	private func steps(_ analytics: Analytics) -> [AnalyticsEvent] {
		analytics.queuedEvents.filter { $0.name == "flow_step" }
	}

	@Test("each step is a flow_step on iphone_first_launch with the person's id as the flow id")
	func shape() {
		let analytics = make()
		analytics.firstLaunch(.chatSent)
		let event = steps(analytics).first
		#expect(
			event?.properties
				== ["flow": "iphone_first_launch", "step": "chat_sent", "flow_id": "actor-1"])
	}

	@Test("every step passes the allowlist with all its properties")
	func allStepsPass() {
		let analytics = make()
		for step in FirstLaunchStep.allCases { analytics.firstLaunch(step) }
		#expect(steps(analytics).count == FirstLaunchStep.allCases.count)
		let names = steps(analytics).compactMap { event -> String? in
			if case .string(let name) = event.properties["step"] { return name }
			return nil
		}
		#expect(Set(names) == Set(FirstLaunchStep.allCases.map(\.rawValue)))
		#expect(steps(analytics).dropFirst().allSatisfy { $0.properties["duration_ms"] != nil })
	}

	@Test("a step goes out once per person, even across launches")
	func oncePerPerson() {
		let storage = InMemoryAnalyticsStorage()
		let first = make(storage: storage)
		first.firstLaunch(.replyReceived)
		first.firstLaunch(.replyReceived)
		#expect(steps(first).count == 1)
		let second = make(storage: storage)
		second.firstLaunch(.replyReceived)
		#expect(steps(second).count == 1)  // only the one restored from the first launch
		second.sessionChanged(actorId: "actor-2", workspaceId: "ws-1")
		second.firstLaunch(.replyReceived)
		// Signing in as someone else clears the first person's unsent events, and the new person
		// gets their own step.
		#expect(steps(second).count == 1)
		#expect(steps(second).last?.properties["flow_id"] == "actor-2")
	}

	@Test("duration_ms is the time since the person's previous step, and absent on the first")
	func duration() {
		let clock = FirstLaunchClock(Date(timeIntervalSince1970: 1_800_000_000))
		let analytics = make(clock: clock)
		analytics.firstLaunch(.firstContent)
		clock.advance(12.5)
		analytics.firstLaunch(.pushPermissionShown)
		let events = steps(analytics)
		#expect(events[0].properties["duration_ms"] == nil)
		#expect(events[1].properties["duration_ms"] == 12_500)
	}

	@Test("nothing goes out, or is used up, while sending is off or nobody is signed in")
	func offAndSignedOut() {
		let signedOut = make(signedIn: false)
		signedOut.firstLaunch(.computerViewOpened)
		#expect(signedOut.queuedEvents.isEmpty)
		signedOut.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		signedOut.firstLaunch(.computerViewOpened)
		#expect(steps(signedOut).count == 1)

		let off = make()
		off.setEnabled(false)
		off.firstLaunch(.chatSent)
		#expect(off.queuedEvents.isEmpty)
		off.setEnabled(true)
		off.firstLaunch(.chatSent)
		#expect(steps(off).count == 1)
	}

	@Test("the step names are in the shared list the server checks")
	func matchesSharedList() throws {
		let repoRoot = URL(fileURLWithPath: #filePath)
			.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
			.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
		let file = repoRoot.appendingPathComponent("packages/shared/src/analytics-flows.ts")
		let source = try String(contentsOf: file, encoding: .utf8)
		let start = try #require(source.range(of: "iphone_first_launch: ["))
		let rest = source[start.upperBound...]
		let block = rest.prefix(upTo: try #require(rest.range(of: "],")).lowerBound)
		for step in FirstLaunchStep.allCases {
			#expect(block.contains("'\(step.rawValue)'"), "\(step.rawValue) is not in the shared list")
		}
	}
}
