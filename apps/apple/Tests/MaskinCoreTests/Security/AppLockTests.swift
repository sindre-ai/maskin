import Foundation
import Testing

@testable import MaskinCore

private final class FakeAuthenticator: AppLockAuthenticating, @unchecked Sendable {
	var availability: AppLockAvailability = .biometric(name: "Face ID")
	var result: AppLockResult = .success
	var calls = 0
	func authenticate(reason: String) async -> AppLockResult {
		calls += 1
		return result
	}
}

private final class Clock: @unchecked Sendable {
	var date = Date(timeIntervalSinceReferenceDate: 800_000_000)
	func advance(_ s: TimeInterval) { date = date.addingTimeInterval(s) }
}

@MainActor
private func make(
	enabled: Bool = false, auth: FakeAuthenticator = FakeAuthenticator(), clock: Clock = Clock()
) -> (AppLockController, FakeAuthenticator, Clock, InMemoryAppLockStorage) {
	let storage = InMemoryAppLockStorage(enabled: enabled)
	let lock = AppLockController(storage: storage, authenticator: auth, now: { clock.date })
	return (lock, auth, clock, storage)
}

@MainActor
struct AppLockTests {
	@Test func offByDefaultAndNeverCovers() {
		let (lock, _, _, _) = make()
		#expect(!lock.isEnabled && !lock.isLocked)
		lock.scenePhaseChanged(.inactive)
		#expect(!lock.shouldCoverContent)
	}

	@Test func coldLaunchWithLockOnStartsLocked() {
		let (lock, _, _, _) = make(enabled: true)
		#expect(lock.isLocked && lock.shouldCoverContent)
	}

	@Test func enablingRequiresAuthenticationAndPersists() async {
		let (lock, auth, _, storage) = make()
		auth.result = .failed
		#expect(await lock.setEnabled(true) == false)
		#expect(!lock.isEnabled && !storage.loadEnabled())
		auth.result = .success
		#expect(await lock.setEnabled(true))
		#expect(lock.isEnabled && !lock.isLocked && storage.loadEnabled())
	}

	@Test func cannotEnableWithoutDeviceAuthentication() async {
		let auth = FakeAuthenticator()
		auth.availability = .unavailable
		let (lock, _, _, _) = make(auth: auth)
		#expect(await lock.setEnabled(true) == false)
		#expect(auth.calls == 0)
	}

	@Test func disablingNeedsNoPromptAndPersists() async {
		let (lock, auth, _, storage) = make(enabled: true)
		await lock.unlock()
		let calls = auth.calls
		#expect(await lock.setEnabled(false) == false)
		#expect(auth.calls == calls && !storage.loadEnabled())
	}

	@Test func shortBackgroundDoesNotLock() async {
		let (lock, _, clock, _) = make(enabled: true)
		await lock.unlock()
		lock.scenePhaseChanged(.inactive)
		lock.scenePhaseChanged(.background)
		clock.advance(AppLockController.gracePeriod - 1)
		lock.scenePhaseChanged(.active)
		#expect(!lock.isLocked && !lock.shouldCoverContent)
	}

	@Test func longBackgroundLocks() async {
		let (lock, _, clock, _) = make(enabled: true)
		await lock.unlock()
		lock.scenePhaseChanged(.background)
		clock.advance(AppLockController.gracePeriod)
		lock.scenePhaseChanged(.active)
		#expect(lock.isLocked)
	}

	@Test func inactiveCoversContentForTheSwitcherSnapshotEvenInGrace() async {
		let (lock, _, _, _) = make(enabled: true)
		await lock.unlock()
		lock.scenePhaseChanged(.inactive)
		#expect(lock.shouldCoverContent && !lock.isLocked)
		lock.scenePhaseChanged(.active)
		#expect(!lock.shouldCoverContent)
	}

	@Test func failedUnlockStaysLockedAndCanRetry() async {
		let (lock, auth, _, _) = make(enabled: true)
		auth.result = .failed
		await lock.unlock()
		#expect(lock.isLocked && lock.lastAttemptFailed)
		auth.result = .success
		await lock.unlock()
		#expect(!lock.isLocked && !lock.lastAttemptFailed)
	}

	@Test func removedPasscodeDisablesTheLockInsteadOfStrandingThePerson() async {
		let (lock, auth, _, storage) = make(enabled: true)
		auth.result = .unavailable
		await lock.unlock()
		#expect(!lock.isEnabled && !lock.isLocked && !storage.loadEnabled())
	}

	@Test func freshSignInDoesNotPrompt() {
		let (lock, _, _, _) = make(enabled: true)
		lock.sessionChanged(hasSession: false)
		#expect(!lock.shouldCoverContent)
		lock.sessionChanged(hasSession: true)
		#expect(!lock.isLocked)
	}

	@Test func restoredSessionStaysLocked() {
		let (lock, _, _, _) = make(enabled: true)
		lock.sessionChanged(hasSession: true)
		#expect(lock.isLocked)
	}
}
