import Testing

@testable import MaskinCore

@MainActor
private final class FakeSession: SpeechAudioSession {
	var outputIsHeadphones: Bool
	/// Long-form activation fails, as it does when the wearer dismisses the route picker.
	var longFormFails = false
	private(set) var activations: [Bool] = []

	init(headphones: Bool) { outputIsHeadphones = headphones }

	func activate(longForm: Bool) async throws {
		activations.append(longForm)
		if longForm && longFormFails { throw CancellationError() }
	}
}

@MainActor
struct WatchSpeechSessionTests {
	@Test func aBareWatchUsesTheStandardSessionNotLongForm() async {
		let session = FakeSession(headphones: false)
		let ready = await WatchSpeech.prepare(session)
		#expect(ready)
		#expect(session.activations == [false])
	}

	@Test func headphonesUseLongForm() async {
		let session = FakeSession(headphones: true)
		let ready = await WatchSpeech.prepare(session)
		#expect(ready)
		#expect(session.activations == [true])
	}

	@Test func aFailedLongFormFallsBackToTheStandardSession() async {
		let session = FakeSession(headphones: true)
		session.longFormFails = true
		let ready = await WatchSpeech.prepare(session)
		#expect(ready)
		#expect(session.activations == [true, false])
	}
}
