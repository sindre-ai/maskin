import Foundation
import Testing

@testable import MaskinCore

private let secret = "ank_SUPERSECRETVALUE0123456789abcd"

@Suite("SecretValue")
struct SecretValueTests {
	@Test("never prints the secret through any string path")
	func redacts() {
		let value = SecretValue(secret)
		var dumped = ""
		dump(value, to: &dumped)
		let outputs = [
			"\(value)", String(describing: value), String(reflecting: value), value.description,
			value.debugDescription, dumped, "\([value])", "\(Optional(value) as Any)",
		]
		for out in outputs {
			#expect(!out.contains("SUPERSECRET"), "leaked in: \(out)")
		}
	}

	@Test("reveal returns the raw value; masked keeps only the ends")
	func revealAndMask() {
		let value = SecretValue(secret)
		#expect(value.reveal() == secret)
		#expect(value.masked.hasPrefix("ank_"))
		#expect(value.masked.hasSuffix("abcd"))
		#expect(!value.masked.contains("SUPERSECRET"))
	}

	@Test("a short secret is fully masked")
	func shortMask() {
		#expect(!SecretValue("abc").masked.contains("abc"))
	}
}

@MainActor
@Suite("APIKeyStore")
struct APIKeyStoreTests {
	private func make(
		_ fake: FakeSettings, adopt: (@MainActor (String) throws -> Void)?
	) -> APIKeyStore {
		fake.regeneratedKey = secret
		return APIKeyStore(api: fake, actorId: "me", adopt: adopt)
	}

	@Test("regenerate adopts the new key and shows it masked until revealed")
	func adoptsAndMasks() async {
		let fake = FakeSettings()
		var adopted: [String] = []
		let store = make(fake) { adopted.append($0) }
		await store.regenerate()
		#expect(adopted == [secret])
		#expect(store.phase == .done)
		#expect(store.displayText == store.newKey?.masked)
		#expect(store.displayText?.contains("SUPERSECRET") == false)
		store.setRevealed(true)
		#expect(store.displayText == secret)
		store.setRevealed(false)
		#expect(store.displayText?.contains("SUPERSECRET") == false)
	}

	@Test("the new key is adopted right after the response, before any other request")
	func adoptsBeforeAnythingElse() async {
		let fake = FakeSettings()
		var callsAtAdoption: [String] = []
		let store = make(fake) { _ in callsAtAdoption = fake.calls }
		await store.regenerate()
		#expect(callsAtAdoption == ["regenerate"])
	}

	@Test("regenerating carries no idempotency key (the server would cache the plaintext key)")
	func noIdempotencyKey() async {
		let fake = FakeSettings()
		let store = make(fake) { _ in }
		await store.regenerate()
		#expect(fake.calls == ["regenerate"])
		#expect(fake.idempotencyKeys.isEmpty)
	}

	@Test("without an adopter regenerating is disabled and makes no request")
	func disabledWithoutAdopter() async {
		let fake = FakeSettings()
		let store = make(fake, adopt: nil)
		#expect(!store.canRegenerate)
		await store.regenerate()
		#expect(fake.calls.isEmpty)
		#expect(store.newKey == nil)
	}

	@Test("a server failure leaves the stored key alone and shows no secret")
	func serverFailure() async {
		let fake = FakeSettings()
		fake.failure = SettingsError("Couldn't regenerate the key.")
		var adopted = false
		let store = make(fake) { _ in adopted = true }
		await store.regenerate()
		#expect(!adopted)
		#expect(store.phase == .idle)
		#expect(store.newKey == nil)
		#expect(store.error == "Couldn't regenerate the key.")
	}

	@Test("a failed adoption is reported and does not claim success")
	func adoptionFailure() async {
		struct Boom: Error {}
		let store = make(FakeSettings()) { _ in throw Boom() }
		await store.regenerate()
		#expect(store.phase == .adoptionFailed)
		#expect(store.error?.contains("Sign in again") == true)
		#expect(store.error?.contains("SUPERSECRET") == false)
	}

	@Test("clear drops the key from memory")
	func clears() async {
		let store = make(FakeSettings()) { _ in }
		await store.regenerate()
		store.setRevealed(true)
		store.clear()
		#expect(store.newKey == nil)
		#expect(store.displayText == nil)
		#expect(!store.isRevealed)
	}

	@Test("the store's reflection and description never include the key")
	func storeDoesNotLeak() async {
		let store = make(FakeSettings()) { _ in }
		await store.regenerate()
		store.setRevealed(true)
		var dumped = ""
		dump(store, to: &dumped)
		#expect(!dumped.contains("SUPERSECRET"))
		#expect(!String(describing: store).contains("SUPERSECRET"))
		#expect(!String(reflecting: store).contains("SUPERSECRET"))
	}

	@Test("a second regenerate while one is running is ignored")
	func noDoubleRegenerate() async {
		let fake = FakeSettings()
		let store = make(fake) { _ in }
		async let a: Void = store.regenerate()
		async let b: Void = store.regenerate()
		_ = await (a, b)
		#expect(fake.calls.filter { $0 == "regenerate" }.count == 1)
	}
}

@MainActor
@Suite("APIKeyStore scene handling")
struct APIKeySceneTests {
	private func rotated() async -> APIKeyStore {
		let store = APIKeyStore(api: FakeSettings(), actorId: "me", adopt: { _ in })
		await store.regenerate()
		store.setRevealed(true)
		return store
	}

	@Test("leaving the foreground masks a revealed key")
	func masksOnInactive() async {
		let store = await rotated()
		#expect(store.isRevealed)
		store.concealForScene(isBackground: false)
		#expect(!store.isRevealed)
		#expect(store.newKey != nil)
	}

	@Test("going to the background drops the key from memory")
	func clearsOnBackground() async {
		let store = await rotated()
		store.concealForScene(isBackground: true)
		#expect(store.newKey == nil)
		#expect(store.displayText == nil)
	}
}

@MainActor
@Suite("APIKeyStore rotation guard")
struct APIKeyRotationGuardTests {
	@Test("begin happens before the POST and adopt after it; a success never cancels")
	func order() async {
		let fake = FakeSettings()
		var log: [String] = []
		let store = APIKeyStore(
			api: fake, actorId: "me",
			adopt: { _ in log.append("adopt:\(fake.calls)") },
			willRotate: { log.append("begin:\(fake.calls)") },
			didFailRotation: { log.append("cancel") })
		await store.regenerate()
		#expect(log == ["begin:[]", "adopt:[\"regenerate\"]"])
	}

	@Test("a failed request cancels the rotation and never adopts")
	func failureCancels() async {
		let fake = FakeSettings()
		fake.failure = SettingsError("down")
		var log: [String] = []
		let store = APIKeyStore(
			api: fake, actorId: "me", adopt: { _ in log.append("adopt") },
			willRotate: { log.append("begin") }, didFailRotation: { log.append("cancel") })
		await store.regenerate()
		#expect(log == ["begin", "cancel"])
	}
}
