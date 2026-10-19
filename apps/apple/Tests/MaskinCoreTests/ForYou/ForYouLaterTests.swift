import Foundation
import Testing

@testable import MaskinCore

private final class Clock: @unchecked Sendable {
	private let lock = NSLock()
	private var _now: Date
	init(_ now: Date) { _now = now }
	var now: Date {
		get { lock.withLock { _now } }
		set { lock.withLock { _now = newValue } }
	}
}

private func at(hour: Int, minute: Int = 0, daysFromNow: Int = 0) -> Date {
	var calendar = Calendar.current
	calendar.timeZone = .current
	let day = calendar.date(byAdding: .day, value: daysFromNow, to: calendar.startOfDay(for: Date()))!
	return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day)!
}

@Suite("LaterPreset")
struct LaterPresetTests {
	@Test func thisEveningIsSixToday() {
		#expect(LaterPreset.thisEvening.resolve(from: at(hour: 9)) == at(hour: 18))
	}

	@Test func thisEveningNeverResolvesToThePast() {
		let late = at(hour: 17, minute: 45)
		#expect(LaterPreset.thisEvening.resolve(from: late) == late.addingTimeInterval(2 * 3600))
		let night = at(hour: 22)
		#expect(LaterPreset.thisEvening.resolve(from: night) > night)
	}

	@Test func tomorrowMorningIsEightTomorrow() {
		#expect(LaterPreset.tomorrowMorning.resolve(from: at(hour: 20)) == at(hour: 8, daysFromNow: 1))
		#expect(LaterPreset.tomorrowMorning.resolve(from: at(hour: 6)) == at(hour: 8, daysFromNow: 1))
	}

	@Test func theNotificationButtonPicksByTimeOfDay() {
		#expect(LaterPreset.suggested(at: at(hour: 10)) == .thisEvening)
		#expect(LaterPreset.suggested(at: at(hour: 16)) == .tomorrowMorning)
	}
}

@MainActor
@Suite("LaterStore")
struct LaterStoreTests {
	private func make(
		clock: Clock = Clock(at(hour: 9)), workspace: String? = "ws-1",
		defaults: UserDefaults = UserDefaults(suiteName: "later-\(UUID().uuidString)")!
	) -> (LaterStore, Clock, UserDefaults) {
		(LaterStore(defaults: defaults, workspaceId: { workspace }, now: { clock.now }), clock, defaults)
	}

	@Test func aDeferredCardIsHiddenUntilItComesDue() {
		let (store, clock, _) = make()
		store.defer("a", preset: .thisEvening)
		#expect(store.isDeferred("a"))
		#expect(store.isBackFromLater("a") == false)
		clock.now = at(hour: 18, minute: 1)
		#expect(store.isDeferred("a") == false)
		#expect(store.isBackFromLater("a"))  // "Back again" until the reader acts
		store.clear("a")
		#expect(store.isBackFromLater("a") == false)
	}

	@Test func deferralsSurviveARelaunchPerWorkspace() {
		let (store, clock, defaults) = make()
		store.defer("a", preset: .tomorrowMorning)
		let reopened = LaterStore(defaults: defaults, workspaceId: { "ws-1" }, now: { clock.now })
		#expect(reopened.isDeferred("a"))
		let other = LaterStore(defaults: defaults, workspaceId: { "ws-2" }, now: { clock.now })
		#expect(other.isDeferred("a") == false)
	}

	@Test func restoreTakesADeferralBack() {
		let (store, _, _) = make()
		store.defer("a", preset: .thisEvening)
		store.restore("a", to: nil)
		#expect(store.isDeferred("a") == false)
	}

	@Test func reloadPicksUpWhatANotificationButtonSaved() {
		let (store, clock, defaults) = make()
		LaterStore.record(entityId: "n", workspace: "ws-1", preset: .tomorrowMorning, now: clock.now, defaults: defaults)
		#expect(store.isDeferred("n") == false)
		store.reload()
		#expect(store.isDeferred("n"))
	}

	@Test func pruneKeepsLiveCardsAndDropsOldOnesForGoneCards() {
		let (store, clock, _) = make()
		store.defer("gone", until: clock.now.addingTimeInterval(60), label: "x")
		store.defer("kept", until: clock.now.addingTimeInterval(60), label: "x")
		clock.now = clock.now.addingTimeInterval(8 * 86_400)
		store.prune(keeping: ["kept"])
		#expect(store.entry(for: "gone") == nil)
		#expect(store.entry(for: "kept") != nil)
	}

	@Test func cameDueBumpsTheClockWithoutAnyViewAction() async {
		let (store, clock, _) = make()
		store.defer("a", until: clock.now.addingTimeInterval(0.1), label: "soon")
		#expect(store.isDeferred("a"))
		clock.now = clock.now.addingTimeInterval(1)
		#expect(store.isDeferred("a") == false)
	}
}
