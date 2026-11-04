import Foundation
import Testing

@testable import MaskinCore

@Suite("NotificationPromptPolicy")
struct NotificationPromptPolicyTests {
	private let now = Date(timeIntervalSince1970: 1_800_000_000)

	@Test("offers only while the system has not been asked")
	func onlyUndecided() {
		let policy = NotificationPromptPolicy(storage: InMemoryNotificationPromptStorage())
		#expect(policy.shouldOffer(permission: .notDetermined, now: now))
		#expect(!policy.shouldOffer(permission: .authorized, now: now), "already on: change nothing")
		#expect(!policy.shouldOffer(permission: .denied, now: now), "the OS wouldn't show it")
	}

	@Test("Not now holds the offer back for seven days, then it returns")
	func snooze() {
		let policy = NotificationPromptPolicy(storage: InMemoryNotificationPromptStorage())
		policy.recordNotNow(now: now)
		#expect(!policy.shouldOffer(permission: .notDetermined, now: now.addingTimeInterval(60)))
		#expect(!policy.shouldOffer(permission: .notDetermined, now: now.addingTimeInterval(6 * 86_400)))
		#expect(policy.shouldOffer(permission: .notDetermined, now: now.addingTimeInterval(7 * 86_400 + 1)))
	}

	@Test("accepting clears a snooze")
	func accepted() {
		let policy = NotificationPromptPolicy(storage: InMemoryNotificationPromptStorage())
		policy.recordNotNow(now: now)
		policy.recordAccepted()
		#expect(policy.shouldOffer(permission: .notDetermined, now: now))
	}

	@Test("the snooze survives a relaunch (UserDefaults)")
	func persists() throws {
		let suite = "prompt-test-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suite))
		defer { defaults.removePersistentDomain(forName: suite) }
		NotificationPromptPolicy(storage: UserDefaultsNotificationPromptStorage(defaults: defaults))
			.recordNotNow(now: now)
		let again = NotificationPromptPolicy(storage: UserDefaultsNotificationPromptStorage(defaults: defaults))
		#expect(!again.shouldOffer(permission: .notDetermined, now: now.addingTimeInterval(86_400)))
	}
}

@MainActor
private final class FakePush: PushPermissionControlling {
	var permission: PushPermission
	var requested = 0
	init(_ permission: PushPermission) { self.permission = permission }
	func refreshPermission() async -> PushPermission { permission }
	func requestAuthorization() async { requested += 1 }
}

@MainActor
@Suite("NotificationPromptCoordinator")
struct NotificationPromptCoordinatorTests {
	private func make(_ permission: PushPermission, storage: InMemoryNotificationPromptStorage = .init())
		-> (NotificationPromptCoordinator, FakePush)
	{
		let push = FakePush(permission)
		return (
			NotificationPromptCoordinator(policy: NotificationPromptPolicy(storage: storage), push: push), push
		)
	}

	@Test("nothing is shown or requested until a moment of value")
	func coldLaunch() {
		let (prompt, push) = make(.notDetermined)
		#expect(!prompt.isPresented)
		#expect(push.requested == 0)
	}

	@Test("a moment of value shows the pre-prompt; only accepting reaches the system prompt")
	func accept() async {
		let (prompt, push) = make(.notDetermined)
		await prompt.valueMoment()
		#expect(prompt.isPresented)
		#expect(push.requested == 0)
		await prompt.accept()
		#expect(!prompt.isPresented)
		#expect(push.requested == 1)
	}

	@Test("Not now never reaches the system and is remembered")
	func notNow() async {
		let storage = InMemoryNotificationPromptStorage()
		let (prompt, push) = make(.notDetermined, storage: storage)
		await prompt.valueMoment()
		prompt.notNow()
		#expect(!prompt.isPresented && push.requested == 0)
		#expect(storage.snoozedUntil() != nil)
		// A later launch inside the week stays quiet.
		let (later, _) = make(.notDetermined, storage: storage)
		await later.valueMoment()
		#expect(!later.isPresented)
	}

	@Test("already authorized or denied: never shown")
	func decided() async {
		for permission in [PushPermission.authorized, .denied] {
			let (prompt, push) = make(permission)
			await prompt.valueMoment()
			#expect(!prompt.isPresented && push.requested == 0)
		}
	}

	@Test("held back while another sheet is open, offered later")
	func blocked() async {
		let (prompt, _) = make(.notDetermined)
		await prompt.valueMoment(canPresent: false)
		#expect(!prompt.isPresented)
		await prompt.valueMoment(canPresent: true)
		#expect(prompt.isPresented)
	}

	@Test("offered once per launch")
	func once() async {
		let (prompt, _) = make(.notDetermined)
		await prompt.valueMoment()
		prompt.notNow()
		await prompt.valueMoment()
		#expect(!prompt.isPresented)
	}
}
