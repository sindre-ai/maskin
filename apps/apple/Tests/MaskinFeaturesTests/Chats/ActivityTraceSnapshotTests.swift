import Foundation
import MaskinCore
import MaskinDesign
import SwiftUI
import Testing

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

@testable import MaskinFeatures

private let start = Date(timeIntervalSince1970: 1_800_000_000)
private let relay = ChatParticipant(id: "relay", name: "Relay", kind: .agent)

private let runningTurn = ActivityTurn(
	sessionID: "s1", messageID: 4, startedAt: start, status: .running,
	steps: [
		ActivityStep(id: "1-0", kind: .thinking, label: "Thinking…", status: .completed),
		ActivityStep(id: "2-0", kind: .toolUse, label: "Using Read", detail: "apps/web/src/routes/index.tsx"),
		ActivityStep(
			id: "3-0", kind: .toolUse, label: "Using Bash", detail: "pnpm --filter @maskin/web type-check",
			status: .running),
	])

private let failedTurn = ActivityTurn(
	sessionID: "s1", messageID: 4, startedAt: start, finishedAt: start.addingTimeInterval(9),
	status: .failed, result: ActivityResult(text: "Credit balance too low", isError: true),
	steps: [
		ActivityStep(id: "1-0", kind: .toolUse, label: "Using Read", detail: "/x.ts"),
		ActivityStep(id: "2-0", kind: .toolUse, label: "Using Bash", detail: "pnpm test", status: .failed),
	])

private let doneTurn = ActivityTurn(
	sessionID: "s1", messageID: 4, startedAt: start, finishedAt: start.addingTimeInterval(8),
	containsReply: true, steps: runningTurn.steps.map {
		var step = $0
		step.status = .completed
		return step
	})

private let questions = [
	ChatQuestionItem(
		index: 0, header: "Rollout", question: "How should the onboarding change ship?", multiSelect: false,
		options: [
			.init(label: "7-day window", detail: "Ships with cycle 1; adds about 18 support tickets", recommended: true),
			.init(label: "Hold", detail: "Nothing ships this cycle"),
		])
]

@MainActor
private func render<V: View>(_ view: V, width: CGFloat, dark: Bool, name: String) throws {
	let framed = view
		.padding(MaskinSpace.s9)
		.frame(width: width)
		.background(MaskinSurface.grouped)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: framed)
	renderer.scale = 2
	guard let image = renderer.cgImage else {
		Issue.record("ImageRenderer produced no image for \(name)")
		return
	}
	guard let dir = ProcessInfo.processInfo.environment["ACTIVITY_SNAPSHOT_DIR"] else { return }
	try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
	let url = URL(fileURLWithPath: dir)
		.appendingPathComponent("\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	#if canImport(AppKit)
	try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: url)
	#elseif canImport(UIKit)
	try UIImage(cgImage: image).pngData()?.write(to: url)
	#endif
}

@Suite("Activity trace snapshots")
@MainActor
struct ActivityTraceSnapshotTests {
	private static let widths: [CGFloat] = [375, 768]

	@Test("live trace, finished summary, expanded trace and failed turn render in both schemes")
	func traces() throws {
		for width in Self.widths {
			for dark in [false, true] {
				try render(
					LiveActivityView(agent: relay, turn: runningTurn, startedAt: start, onStop: {}),
					width: width, dark: dark, name: "live")
				try render(
					LiveActivityView(agent: relay, fallbackActivity: "Reading the brief", onStop: nil),
					width: width, dark: dark, name: "live-fallback")
				try render(FinishedTraceView(turn: doneTurn), width: width, dark: dark, name: "done-collapsed")
				try render(
					FinishedTraceView(turn: doneTurn, expanded: true), width: width, dark: dark,
					name: "done-expanded")
				try render(
					FinishedTraceView(turn: failedTurn, expanded: true), width: width, dark: dark,
					name: "failed")
			}
		}
	}

	@Test("the decision card renders with the recommended option marked")
	func decisionCard() throws {
		for width in Self.widths {
			for dark in [false, true] {
				try render(
					QuestionOptionsView(
						questions: questions, answers: nil, picked: [0: ["Hold"]], onSubmit: { _ in }),
					width: width, dark: dark, name: "decision")
				try render(
					QuestionOptionsView(questions: questions, answers: nil, onSubmit: { _ in }),
					width: width, dark: dark, name: "decision-open")
			}
		}
	}

	@Test("elapsed label formats seconds and minutes")
	func elapsed() {
		#expect(ElapsedLabel.text(from: start, to: start.addingTimeInterval(7)) == "7s")
		#expect(ElapsedLabel.text(from: start, to: start.addingTimeInterval(64)) == "1m 04s")
		#expect(ElapsedLabel.text(from: start, to: start.addingTimeInterval(-5)) == "0s")
	}
}
