import Foundation
import Testing

@testable import MaskinCore

private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

private func step(_ label: String, at offset: TimeInterval, done: TimeInterval? = nil) -> ActivityStep {
	ActivityStep(
		id: label, kind: .toolUse, label: label, startedAt: t0.addingTimeInterval(offset),
		finishedAt: done.map { t0.addingTimeInterval($0) }, status: done == nil ? .running : .completed)
}

private func turn(_ steps: [ActivityStep]) -> ActivityTurn {
	ActivityTurn(sessionID: "s1", messageID: 5, startedAt: t0, status: .running, steps: steps)
}

@Suite("LiveActivityLine")
struct LiveActivityLineTests {
	@Test("no steps yet reads Starting…, not a bare working")
	func starting() {
		let line = LiveActivityLine.resolve(
			turn: nil, fallbackActivity: nil, startedAt: t0, now: t0.addingTimeInterval(5))
		#expect(line.phase == .starting)
		#expect(line.text == "Starting…")
	}

	@Test("the session's own activity stands in until steps arrive")
	func fallback() {
		let line = LiveActivityLine.resolve(
			turn: nil, fallbackActivity: "Reading the brief", startedAt: t0, now: t0.addingTimeInterval(5))
		#expect(line.phase == .active)
		#expect(line.text == "Reading the brief")
	}

	@Test("the newest step wins over the session activity")
	func newestStep() {
		let t = turn([step("Reading Thread.swift", at: 1, done: 2), step("Running tests", at: 3)])
		let line = LiveActivityLine.resolve(
			turn: t, fallbackActivity: "old", startedAt: t0, now: t0.addingTimeInterval(10))
		#expect(line.phase == .active)
		#expect(line.text == "Running tests")
		#expect(line.step?.id == "Running tests")
	}

	@Test("a minute without news says Still working… and keeps the last step")
	func stalled() {
		let t = turn([step("Running tests", at: 3)])
		let line = LiveActivityLine.resolve(
			turn: t, fallbackActivity: nil, startedAt: t0, now: t0.addingTimeInterval(3 + 61))
		#expect(line.phase == .stalled)
		#expect(line.text == "Still working… Running tests")
	}

	@Test("a stall with nothing known says only Still working…")
	func stalledBlank() {
		let line = LiveActivityLine.resolve(
			turn: nil, fallbackActivity: nil, startedAt: t0, now: t0.addingTimeInterval(90))
		#expect(line.phase == .stalled)
		#expect(line.text == "Still working…")
	}

	@Test("a step finishing counts as activity")
	func finishResets() {
		let t = turn([step("Build", at: 0, done: 100)])
		let line = LiveActivityLine.resolve(
			turn: t, fallbackActivity: nil, startedAt: t0, now: t0.addingTimeInterval(130))
		#expect(line.phase == .active)
	}
}
