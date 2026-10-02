import Foundation
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
import Testing
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

@testable import MaskinFeatures

private let relay = AutomationActor(id: "agent-1", name: "Relay", isAgent: true)
private let forge = AutomationActor(id: "agent-2", name: "Forge", isAgent: true)
private let scout = AutomationActor(id: "agent-3", name: "Scout", isAgent: true)
private let base = Date()

private actor FixtureLoopsAPI: LoopsAPI {
	func loops() async throws -> [LoopSummary] { [fixtureLoop] }
	func steps(loopID: String) async throws -> [LoopStep] { fixtureSteps }
	func activity(loopID: String) async throws -> [LoopActivityEntry] { fixtureActivity }
	func actors() async throws -> [AutomationActor] { [relay, forge, scout] }
	func installs() async throws -> [LoopInstall] { [] }
	func setStatus(loopID: String, status: LoopPill, idempotencyKey: String) async throws {}
}

private let fixtureLoop = LoopSummary(
	id: "l1", name: "Inbound lead qualification",
	content: "Every new lead is researched, scored and routed to the right rep.", status: .supervised,
	pill: .waitingOnYou, entryCondition: "A new lead is created",
	closeCondition: "The lead is booked or disqualified", inProgressCount: 7, closedCount: 142,
	medianTimeToClose: 3600 * 5, agentIDs: ["agent-1", "agent-2", "agent-3"], triggerIDs: ["t1", "t2"],
	waitingCount: 2, updatedAt: base.addingTimeInterval(-600))

private let fixtureSteps = [
	LoopStep(
		triggerID: "t1", name: "Research the lead", triggerKind: .event,
		triggerConfig: .object(["entity_type": .string("insight"), "action": .string("created")]),
		agentName: "Scout", agentID: "agent-3", handsOffName: "Relay"),
	LoopStep(
		triggerID: "t2", name: "Score and route", triggerKind: .cron,
		triggerConfig: .object(["expression": .string("0 9 * * 1")]), agentName: "Relay",
		agentID: "agent-1", handsOffName: "Alex", escalatesToName: "Forge", escalateAfter: 86400,
		pendingCount: 2),
]

private let fixtureActivity = [
	LoopActivityEntry(id: "3", action: "session_completed", entityType: "session", actorID: "agent-1", createdAt: base.addingTimeInterval(-300)),
	LoopActivityEntry(id: "2", action: "session_failed", entityType: "session", actorID: "agent-3", description: "Scout hit a rate limit", createdAt: base.addingTimeInterval(-3600)),
	LoopActivityEntry(id: "1", action: "trigger_fired", entityType: "trigger", createdAt: base.addingTimeInterval(-7200)),
]

@MainActor
private func render<V: View>(_ view: V, width: CGFloat, dark: Bool, name: String) throws {
	let framed = view
		.frame(width: width)
		.background(MaskinSurface.grouped)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: framed)
	renderer.scale = 2
	guard let image = renderer.cgImage else {
		Issue.record("ImageRenderer produced no image for \(name)")
		return
	}
	let dir =
		ProcessInfo.processInfo.environment["LOOPS_SNAPSHOT_DIR"]
		?? NSTemporaryDirectory() + "loops-snapshots"
	try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
	let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	#if canImport(AppKit)
	try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: url)
	#elseif canImport(UIKit)
	try UIImage(cgImage: image).pngData()?.write(to: url)
	#endif
}

@Suite("Loops and triggers snapshots")
@MainActor
struct LoopsSnapshotTests {
	static let widths: [CGFloat] = [402, 820]

	@Test("loop rows render in every state", arguments: [false, true])
	func rows(dark: Bool) throws {
		let rows: [(LoopSummary, [String], Bool)] = [
			(fixtureLoop, ["Relay", "Forge", "Scout"], true),
			(LoopSummary(id: "2", name: "Weekly investor update", status: .fullyAutonomous, inProgressCount: 1, closedCount: 38, updatedAt: base.addingTimeInterval(-86400)), ["Relay"], false),
			(LoopSummary(id: "3", name: nil, status: .paused, updatedAt: base.addingTimeInterval(-86400 * 9)), [], false),
			(LoopSummary(id: "4", name: "Support triage with an unusually long name that has to wrap", status: .draft), ["Forge", "Scout", "Relay", "A", "B", "C"], false),
		]
		for width in Self.widths {
			let view = VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				ForEach(rows, id: \.0.id) { LoopRow(loop: $0.0, agentNames: $0.1, hasUpdate: $0.2) }
			}
			.padding(MaskinSpace.s9)
			try render(view, width: width, dark: dark, name: "loop-rows")
		}
	}

	@Test("loop detail renders steps, stats and activity", arguments: [false, true])
	func detail(dark: Bool) async throws {
		let store = LoopDetailStore(
			loop: fixtureLoop, api: FixtureLoopsAPI(), events: nil)
		await store.start()
		#expect(store.steps.count == 2)
		#expect(store.activity.count == 3)
		for width in Self.widths {
			try render(LoopDetailContent(store: store).padding(MaskinSpace.s9), width: width, dark: dark, name: "loop-detail")
		}
	}

	@Test("trigger rows render on, off and unresolved", arguments: [false, true])
	func triggerRows(dark: Bool) throws {
		let on = Trigger(id: "1", name: "Morning brief", kind: .cron, config: .object(["expression": .string("0 9 * * 1")]), actionPrompt: "x", targetActorID: "agent-1")
		let event = Trigger(id: "2", name: "Review new bets", kind: .event, config: .object(["entity_type": .string("bet"), "action": .string("status_changed"), "from_status": .string("proposed"), "to_status": .string("active")]), actionPrompt: "x", targetActorID: "agent-2", enabled: false)
		let raw = Trigger(id: "3", name: "Every five minutes, with a very long descriptive name", kind: .cron, config: .object(["expression": .string("*/5 * * * *")]), actionPrompt: "x", targetActorID: "ghost")
		for width in Self.widths {
			let view = VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				TriggerRow(trigger: on, agentName: "Relay", onToggle: { _ in })
				TriggerRow(trigger: event, agentName: "Forge", onToggle: { _ in })
				TriggerRow(trigger: raw, agentName: "Unknown agent", onToggle: { _ in })
			}
			.padding(MaskinSpace.s9)
			try render(view, width: width, dark: dark, name: "trigger-rows")
		}
	}

	@Test("loop pills render all states", arguments: [false, true])
	func pills(dark: Bool) throws {
		for width in Self.widths {
			let view = VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				ForEach(LoopPill.allCases, id: \.rawValue) { LoopPillView(pill: $0) }
			}
			.padding(MaskinSpace.s9)
			try render(view, width: width, dark: dark, name: "loop-pills")
		}
	}

	@Test("empty state renders", arguments: [false, true])
	func empty(dark: Bool) throws {
		for width in Self.widths {
			let view = EmptyState(symbol: "bolt", title: "No triggers yet", message: "Triggers wake an agent on a schedule or when something happens.") {
				Button("New schedule") {}.buttonStyle(.primaryAction)
			}
			.frame(height: 320)
			try render(view, width: width, dark: dark, name: "triggers-empty")
		}
	}

	@Test("pill palette keys all resolve to a known status colour")
	func paletteKeys() {
		for pill in LoopPill.allCases {
			#expect(MaskinStatus.tokenKey(for: LoopPillView.paletteKey(pill)) != nil)
		}
	}
}
