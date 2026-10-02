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

private let base = Date()

private func session(
	_ id: String, _ status: String, _ prompt: String, minutesAgo: Double, minutes: Double = 4,
	activity: String? = nil
) -> AgentSession {
	let start = base.addingTimeInterval(-minutesAgo * 60)
	return AgentSession(
		id: id, actorID: "forge", status: status, prompt: prompt, currentActivity: activity,
		startedAt: start,
		completedAt: status == "running" || status == "paused" ? nil : start.addingTimeInterval(minutes * 60),
		createdAt: start)
}

private let summaries: [AgentSummary] = [
	AgentSummary(
		id: "forge", name: "Forge", description: "Ships fixes and keeps CI green", storedState: .idle,
		latestSession: session("s1", "running", "Fix the importer", minutesAgo: 3, activity: "Running the test suite")),
	AgentSummary(
		id: "relay", name: "Relay", description: "Routes inbound mail to the right owner", storedState: .paused,
		latestSession: session("s2", "paused", "Triage", minutesAgo: 90)),
	AgentSummary(
		id: "quill", name: "Quill", description: "Drafts weekly updates", storedState: .idle,
		latestSession: session("s3", "completed", "Weekly update", minutesAgo: 60 * 30)),
	AgentSummary(
		id: "sentinel", name: "Sentinel", description: "Watches production", storedState: .idle,
		latestSession: session("s4", "failed", "Check alerts", minutesAgo: 60 * 5)),
]

private actor FixtureDetailAPI: AgentDetailAPI {
	let profileValue: AgentProfile
	let rows: [AgentSession]
	init(_ p: AgentProfile, _ rows: [AgentSession]) {
		profileValue = p
		self.rows = rows
	}
	func profile(agentID: String) async throws -> AgentProfile { profileValue }
	func sessions(agentID: String, limit: Int) async throws -> [AgentSession] { rows }
	func run(agentID: String, prompt: String?, idempotencyKey: String) async throws -> AgentStatus { .running }
	func pause(agentID: String, idempotencyKey: String) async throws -> AgentStatus { .paused }
	func reset(agentID: String, idempotencyKey: String) async throws -> AgentStatus { .idle }
	func stop(sessionID: String, idempotencyKey: String) async throws {}
}

@MainActor
private func detailStore(running: Bool, system: Bool = false) async -> AgentDetailStore {
	let profile = AgentProfile(
		id: "forge", name: "Forge", description: "Ships fixes and keeps CI green",
		systemPrompt:
			"You are Forge. Pick up failing builds, find the root cause, and open a small, reviewed fix. Never merge your own work.",
		llmProvider: "claude", tools: [AgentTool(name: "github", kind: "http"), AgentTool(name: "slack", kind: "http")],
		skills: ["triage", "release-notes"], isSystem: system, storedState: running ? .running : .idle)
	let rows =
		(running ? [session("s1", "running", "Fix the importer", minutesAgo: 3, activity: "Running the test suite")] : [])
		+ [
			session("s2", "completed", "Fix flaky login test", minutesAgo: 60 * 3),
			session("s3", "failed", "Upgrade the toolchain", minutesAgo: 60 * 26, minutes: 12),
		]
	let store = AgentDetailStore(agentID: "forge", api: FixtureDetailAPI(profile, rows), events: nil)
	await store.refresh()
	return store
}

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
		ProcessInfo.processInfo.environment["AGENTS_SNAPSHOT_DIR"]
		?? NSTemporaryDirectory() + "agents-snapshots"
	try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
	let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	#if canImport(AppKit)
	try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: url)
	#elseif canImport(UIKit)
	try UIImage(cgImage: image).pngData()?.write(to: url)
	#endif
}

@Suite("Agents snapshots")
@MainActor
struct AgentSnapshotTests {
	static let widths: [CGFloat] = [402, 820]

	@Test("agent list rows render by state", arguments: [false, true])
	func list(dark: Bool) throws {
		for width in Self.widths {
			let view = VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				ForEach(AgentStatus.allCases, id: \.self) { status in
					MonoLabel(status.label)
					ForEach(summaries.filter { $0.status == status }) { AgentRow(agent: $0) }
				}
			}
			.padding(MaskinSpace.s9)
			try render(view, width: width, dark: dark, name: "list")
		}
		#expect(summaries.map(\.status) == [.running, .paused, .idle, .failed])
	}

	@Test("agent detail renders while working", arguments: [false, true])
	func detailRunning(dark: Bool) async throws {
		let store = await detailStore(running: true)
		for width in Self.widths {
			let view = VStack(alignment: .leading, spacing: MaskinSpace.s11) {
				AgentDetailContent(profile: store.profile!, store: store)
			}
			.padding(MaskinSpace.s9)
			try render(view, width: width, dark: dark, name: "detail-running")
		}
		#expect(store.status == .running)
	}

	@Test("agent detail renders idle with reset for a system agent", arguments: [false, true])
	func detailIdle(dark: Bool) async throws {
		let store = await detailStore(running: false, system: true)
		for width in Self.widths {
			let view = VStack(alignment: .leading, spacing: MaskinSpace.s11) {
				AgentDetailContent(profile: store.profile!, store: store)
			}
			.padding(MaskinSpace.s9)
			try render(view, width: width, dark: dark, name: "detail-idle")
		}
		#expect(store.canReset)
	}

	@Test("empty and loading states render", arguments: [false, true])
	func empty(dark: Bool) throws {
		for width in Self.widths {
			let view = EmptyState(
				symbol: "person.2", title: "Nobody on this team yet",
				message: "Agents own one outcome each and run on their own.")
			try render(view.frame(height: 260), width: width, dark: dark, name: "empty")
		}
	}

	@Test("run sheet renders", arguments: [false, true])
	func runSheet(dark: Bool) throws {
		for width in Self.widths {
			try render(
				RunAgentSheet(agentName: "Forge") { _ in true }.frame(height: 360), width: width,
				dark: dark, name: "run-sheet")
		}
	}
}
