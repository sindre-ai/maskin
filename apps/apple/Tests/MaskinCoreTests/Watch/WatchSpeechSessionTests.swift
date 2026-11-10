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

struct SpeechPlaybackTests {
	@Test func startingIsNotSpeakingUntilSoundStarts() {
		var playback = SpeechPlayback()
		playback.begin()
		#expect(playback.phase == .starting)
		#expect(playback.isActive)
		playback.audioStarted()
		#expect(playback.phase == .speaking)
	}

	@Test func aStartThatNeverMakesSoundFails() {
		var playback = SpeechPlayback()
		playback.begin()
		#expect(playback.startTimedOut())
		#expect(playback.phase == .failed)
		#expect(!playback.isActive)
	}

	@Test func aTimeoutAfterSoundStartedChangesNothing() {
		var playback = SpeechPlayback()
		playback.begin()
		playback.audioStarted()
		#expect(!playback.startTimedOut())
		#expect(playback.phase == .speaking)
	}

	@Test func pauseAndResumeOnlyApplyToSound() {
		var playback = SpeechPlayback()
		playback.begin()
		playback.pause()
		#expect(playback.phase == .starting)
		playback.audioStarted()
		playback.pause()
		#expect(playback.phase == .paused)
		playback.resume()
		#expect(playback.phase == .speaking)
	}

	@Test func aFailedStartCanBeTriedAgain() {
		var playback = SpeechPlayback()
		playback.begin()
		playback.startTimedOut()
		playback.begin()
		#expect(playback.phase == .starting)
	}
}
