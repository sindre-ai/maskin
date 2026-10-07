import Foundation
import Testing

@testable import MaskinCore

@Suite("TriggerDraft")
struct TriggerDraftTests {
	private func scheduled() -> TriggerDraft {
		var d = TriggerDraft()
		d.targetActorID = "agent-1"
		d.actionPrompt = "Do it"
		return d
	}

	@Test func scheduleNeedsOnlyThen() {
		var d = TriggerDraft()
		#expect(!d.isValid)
		d.targetActorID = "agent-1"
		#expect(!d.isValid)
		d.actionPrompt = "  Do it "
		#expect(d.isValid)
	}

	@Test func eventNeedsAnEventPicked() {
		var d = scheduled()
		d.whenKind = .event
		#expect(!d.hasWhen)
		#expect(!d.isValid)
		d.event = TriggerEventRule(entityType: "task", action: "created")
		#expect(d.isValid)
	}

	@Test func nameFallsBackToTheWhenInWords() {
		var d = scheduled()
		#expect(!d.resolvedName.isEmpty)
		d.whenKind = .event
		d.event = TriggerEventRule(entityType: "bet", action: "status_changed")
		#expect(d.resolvedName == "Bet status changed")
		d.name = " Mine "
		#expect(d.resolvedName == "Mine")
	}

	@Test func eventsAreNamedInPlainWords() {
		#expect(TriggerEventRule(entityType: "task", action: "created").plainName == "Task created")
		#expect(TriggerEventRule.options.count == 9)
		#expect(Set(TriggerEventRule.options.map(\.id)).count == 9)
	}

	@Test func whenFingerprintDiffersBetweenKinds() {
		var a = scheduled()
		var b = scheduled()
		b.whenKind = .event
		b.event = TriggerEventRule(entityType: "task", action: "created")
		#expect(a.whenFingerprint != b.whenFingerprint)
		a.schedule.hour = 3
		#expect(a.whenFingerprint.hasPrefix("cron:"))
	}

	@Test func sessionStatusMapsToRunOutcome() {
		#expect(TriggerRun.outcome(forStatus: "completed") == .ok)
		#expect(TriggerRun.outcome(forStatus: "failed") == .failed)
		#expect(TriggerRun.outcome(forStatus: "timeout") == .failed)
		#expect(TriggerRun.outcome(forStatus: "running") == .running)
	}
}
