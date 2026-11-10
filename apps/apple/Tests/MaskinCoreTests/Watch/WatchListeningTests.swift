import Foundation
import Testing

@testable import MaskinCore

@MainActor
private final class FakeMicrophone: PhraseMicrophone {
	var startError: Error?
	/// What the permission prompt answers, after `accessDelay`.
	var access = true
	var accessDelay: Duration = .zero
	private(set) var starts = 0
	private(set) var stops = 0
	private var continuation: AsyncStream<Data>.Continuation?
	/// Said before the microphone opened (it opens after the permission answer).
	private var early: [Data] = []

	func requestAccess() async -> Bool {
		if accessDelay > .zero { try? await Task.sleep(for: accessDelay) }
		return access
	}

	func start() throws -> AsyncStream<Data> {
		if let startError { throw startError }
		starts += 1
		let (stream, continuation) = AsyncStream.makeStream(of: Data.self)
		self.continuation = continuation
		for phrase in early { continuation.yield(phrase) }
		early = []
		return stream
	}

	func stop() {
		stops += 1
		continuation?.finish()
		continuation = nil
	}

	/// One closed phrase; the fake transcriber answers by the byte.
	func say(_ marker: UInt8) {
		if let continuation { continuation.yield(Data([marker])) } else { early.append(Data([marker])) }
	}
}

private struct FakeTranscriber: SpeechTranscribing {
	var words: [UInt8: String]
	var fails = false

	func transcribe(wav: Data, language: String?) async throws -> String {
		if fails { throw BackendDictationError() }
		return words[wav.first ?? 0] ?? ""
	}
}

@MainActor
private final class Sink {
	var sent: [String] = []
}

@MainActor
private func makeStore(
	mic: FakeMicrophone, transcriber: (any SpeechTranscribing)?, sink: Sink,
	settle: Duration = .milliseconds(60)
) -> WatchListeningStore {
	WatchListeningStore(
		transcriber: transcriber, settle: settle, maxDuration: .seconds(600), drainTimeout: .seconds(30),
		makeMicrophone: { mic }, deliver: { sink.sent.append($0) })
}

@MainActor
private func waitUntil(_ condition: () -> Bool) async {
	// A wall-clock deadline, not an iteration count: under a loaded test run a sleep overshoots.
	let deadline = ContinuousClock.now.advanced(by: .seconds(30))
	while !condition(), ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(5)) }
}

@MainActor
struct WatchListeningTests {
	@Test func sendsTheQuestionAfterAPause() async {
		let mic = FakeMicrophone()
		let sink = Sink()
		let store = makeStore(mic: mic, transcriber: FakeTranscriber(words: [1: "What is holding up"]), sink: sink)
		store.begin()
		#expect(store.phase == .listening)
		mic.say(1)
		await waitUntil { !sink.sent.isEmpty }
		#expect(sink.sent == ["What is holding up"])
		#expect(store.phase == .idle)
		#expect(mic.stops >= 1)
	}

	@Test func aNewPhraseKeepsListeningAndJoinsTheText() async {
		let mic = FakeMicrophone()
		let sink = Sink()
		// A settle time far longer than the test: only Done ends it, so no real-time race.
		let store = makeStore(
			mic: mic, transcriber: FakeTranscriber(words: [1: "What is", 2: "the plan"]), sink: sink,
			settle: .seconds(600))
		store.begin()
		mic.say(1)
		await waitUntil { store.text == "What is" }
		mic.say(2)
		await waitUntil { store.text == "What is the plan" }
		#expect(store.phase == .listening)
		#expect(sink.sent.isEmpty)
		store.done()
		await waitUntil { !sink.sent.isEmpty }
		#expect(sink.sent == ["What is the plan"])
	}

	@Test func doneSendsWhatWasHeard() async {
		let mic = FakeMicrophone()
		let sink = Sink()
		let store = makeStore(
			mic: mic, transcriber: FakeTranscriber(words: [1: "Hello"]), sink: sink, settle: .seconds(30))
		store.begin()
		mic.say(1)
		await waitUntil { store.text == "Hello" }
		store.done()
		await waitUntil { !sink.sent.isEmpty }
		#expect(sink.sent == ["Hello"])
	}

	@Test func doneWithNothingHeardSendsNothingAndLeaves() async {
		let mic = FakeMicrophone()
		let sink = Sink()
		let store = makeStore(mic: mic, transcriber: FakeTranscriber(words: [:]), sink: sink)
		store.begin()
		store.done()
		await waitUntil { store.phase == .idle }
		#expect(store.phase == .idle)
		#expect(sink.sent.isEmpty)
	}

	@Test func cancelSendsNothing() async {
		let mic = FakeMicrophone()
		let sink = Sink()
		let store = makeStore(mic: mic, transcriber: FakeTranscriber(words: [1: "Hello"]), sink: sink)
		store.begin()
		mic.say(1)
		store.cancel()
		try? await Task.sleep(for: .milliseconds(200))
		#expect(store.phase == .idle)
		#expect(sink.sent.isEmpty)
	}

	@Test func aFailedTranscriptionFallsBackToTapToTalk() async {
		let mic = FakeMicrophone()
		let sink = Sink()
		let store = makeStore(mic: mic, transcriber: FakeTranscriber(words: [:], fails: true), sink: sink)
		store.begin()
		mic.say(1)
		await waitUntil { store.phase == .tapToTalk(.weakSignal) }
		#expect(store.phase == .tapToTalk(.weakSignal))
		#expect(sink.sent.isEmpty)
		#expect(mic.stops >= 1)
	}

	@Test func signedOutGoesStraightToTapToTalk() {
		let mic = FakeMicrophone()
		let store = makeStore(mic: mic, transcriber: nil, sink: Sink())
		store.begin()
		#expect(store.phase == .tapToTalk(.unavailable))
	}

	@Test func aMicrophoneThatWillNotOpenGoesToTapToTalk() async {
		let mic = FakeMicrophone()
		mic.startError = BackendDictationError()
		let store = makeStore(mic: mic, transcriber: FakeTranscriber(words: [:]), sink: Sink())
		store.begin()
		await waitUntil { store.phase == .tapToTalk(.microphone) }
		#expect(store.phase == .tapToTalk(.microphone))
	}

	@Test func refusedMicrophoneAccessGoesToTapToTalkWithoutOpeningIt() async {
		let mic = FakeMicrophone()
		mic.access = false
		let store = makeStore(mic: mic, transcriber: FakeTranscriber(words: [:]), sink: Sink())
		store.begin()
		await waitUntil { store.phase == .tapToTalk(.microphone) }
		#expect(store.phase == .tapToTalk(.microphone))
		#expect(mic.starts == 0)
	}

	@Test func theMicrophoneOpensOnlyAfterAccessIsGranted() async {
		let mic = FakeMicrophone()
		mic.accessDelay = .milliseconds(150)
		let sink = Sink()
		let store = makeStore(mic: mic, transcriber: FakeTranscriber(words: [1: "Hello"]), sink: sink)
		store.begin()
		#expect(mic.starts == 0)
		await waitUntil { mic.starts == 1 }
		mic.say(1)
		await waitUntil { !sink.sent.isEmpty }
		#expect(sink.sent == ["Hello"])
	}

	@Test func cancelWhileThePromptIsUpLeavesTheMicrophoneClosed() async {
		let mic = FakeMicrophone()
		mic.accessDelay = .milliseconds(100)
		let store = makeStore(mic: mic, transcriber: FakeTranscriber(words: [:]), sink: Sink())
		store.begin()
		store.cancel()
		try? await Task.sleep(for: .milliseconds(300))
		#expect(mic.starts == 0)
		#expect(store.phase == .idle)
	}

	@Test func tapToTalkCanListenAgain() async {
		let mic = FakeMicrophone()
		let sink = Sink()
		let store = makeStore(mic: mic, transcriber: FakeTranscriber(words: [1: "Again"]), sink: sink)
		mic.startError = BackendDictationError()
		store.begin()
		await waitUntil { store.phase == .tapToTalk(.microphone) }
		#expect(store.phase == .tapToTalk(.microphone))
		mic.startError = nil
		store.begin()
		#expect(store.phase == .listening)
		mic.say(1)
		await waitUntil { !sink.sent.isEmpty }
		#expect(sink.sent == ["Again"])
	}
}
