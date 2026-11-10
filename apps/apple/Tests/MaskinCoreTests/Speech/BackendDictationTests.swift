import Foundation
import Testing

@testable import MaskinCore

@Suite("PhraseSegmenter")
struct PhraseSegmenterTests {
	@Test func silenceAloneDoesNothingUntilTheSegmentCap() {
		var segmenter = PhraseSegmenter()
		#expect(segmenter.push(rms: 0, atMs: 1_000) == nil)
		#expect(segmenter.push(rms: 0, atMs: 5_900) == nil)
		#expect(segmenter.push(rms: 0, atMs: 6_000) == .discard)
	}

	@Test func aPauseAfterSpeechClosesThePhrase() {
		var segmenter = PhraseSegmenter()
		#expect(segmenter.push(rms: 0.1, atMs: 500) == nil)
		#expect(segmenter.push(rms: 0, atMs: 800) == nil)
		#expect(segmenter.push(rms: 0, atMs: 900) == .cut)
		#expect(segmenter.hasVoice)
	}

	@Test func aLongPhraseClosesOnAShorterBreath() {
		var segmenter = PhraseSegmenter()
		#expect(segmenter.push(rms: 0.1, atMs: 2_100) == nil)
		#expect(segmenter.push(rms: 0, atMs: 2_200) == nil)
		#expect(segmenter.push(rms: 0, atMs: 2_250) == .cut)
	}

	@Test func aSpeakerWhoNeverPausesIsCutAtTheCap() {
		var segmenter = PhraseSegmenter()
		var now = 0.0
		var action: PhraseSegmenter.Action?
		while action == nil, now < 10_000 {
			now += 50
			action = segmenter.push(rms: 0.1, atMs: now)
		}
		#expect(action == .cut)
		#expect(now == 6_000)
	}

	@Test func quietSpeechInAQuietRoomStillCountsAsSpeech() {
		// An iPad in measurement mode: room noise near 0.001, speech around 0.008 (under the old fixed 0.02).
		var segmenter = PhraseSegmenter()
		var now = 0.0
		for _ in 0..<20 {
			now += 21
			_ = segmenter.push(rms: 0.001, atMs: now)
		}
		#expect(!segmenter.hasVoice)
		now += 21
		#expect(segmenter.push(rms: 0.008, atMs: now) == nil)
		#expect(segmenter.hasVoice)
		now += 21
		_ = segmenter.push(rms: 0.001, atMs: now)
		now += 400
		#expect(segmenter.push(rms: 0.001, atMs: now) == .cut)
	}

	@Test func roomNoiseBelowTheSpeechLevelIsNotSpeech() {
		var segmenter = PhraseSegmenter()
		var now = 0.0
		for _ in 0..<100 {
			now += 21
			_ = segmenter.push(rms: 0.003, atMs: now)
		}
		#expect(!segmenter.hasVoice)
		#expect(segmenter.threshold >= 0.004)
	}

	@Test func aNoisyRoomKeepsTheOldFixedLevel() {
		var segmenter = PhraseSegmenter()
		var now = 0.0
		for _ in 0..<50 {
			now += 21
			_ = segmenter.push(rms: 0.015, atMs: now)
		}
		#expect(segmenter.threshold == 0.02)
	}

	@Test func resetStartsAFreshSegment() {
		var segmenter = PhraseSegmenter()
		_ = segmenter.push(rms: 0.1, atMs: 100)
		segmenter.reset(atMs: 1_000)
		#expect(!segmenter.hasVoice)
		#expect(segmenter.push(rms: 0, atMs: 1_500) == nil)
	}
}

@Suite("WAVEncoding")
struct WAVEncodingTests {
	@Test func headerDescribes16kHzMono16BitPCM() {
		let wav = WAVEncoding.wav(pcm16: [0, 1, -1])
		#expect(wav.count == 44 + 6)
		#expect(String(decoding: wav[0..<4], as: UTF8.self) == "RIFF")
		#expect(String(decoding: wav[8..<16], as: UTF8.self) == "WAVEfmt ")
		#expect(String(decoding: wav[36..<40], as: UTF8.self) == "data")
		#expect(littleEndian32(wav, at: 4) == 36 + 6)
		#expect(littleEndian32(wav, at: 24) == 16_000)
		#expect(littleEndian32(wav, at: 28) == 32_000)
		#expect(littleEndian32(wav, at: 40) == 6)
	}

	@Test func samplesAreLittleEndian() {
		let wav = WAVEncoding.wav(pcm16: [0x0102, -2])
		#expect(Array(wav[44..<48]) == [0x02, 0x01, 0xFE, 0xFF])
	}

	@Test func floatsAreScaledAndClipped() {
		#expect(WAVEncoding.pcm16(from: [0, 1, -1, 2, -2, 0.5]) == [0, 32_767, -32_767, 32_767, -32_767, 16_384])
	}

	private func littleEndian32(_ data: Data, at offset: Int) -> UInt32 {
		(0..<4).reduce(0) { $0 | UInt32(data[offset + $1]) << (8 * UInt32($1)) }
	}
}

@Suite("DictationLanguage")
struct DictationLanguageTests {
	@Test func usesTheFirstLanguageAsABareCode() {
		#expect(DictationLanguage.hint(preferredLanguages: ["da-DK", "en-US"]) == "da")
		#expect(DictationLanguage.hint(preferredLanguages: ["en_GB"]) == "en")
		#expect(DictationLanguage.hint(preferredLanguages: ["zh-Hans-CN"]) == "zh")
	}

	@Test func sendsNothingWhenThereIsNoUsableCode() {
		#expect(DictationLanguage.hint(preferredLanguages: []) == nil)
		#expect(DictationLanguage.hint(preferredLanguages: ["x"]) == nil)
		#expect(DictationLanguage.hint(preferredLanguages: ["1234"]) == nil)
	}
}

/// Answers each call from a script; a phrase's `delay` makes it finish after later ones.
private final class ScriptedTranscriber: SpeechTranscribing, @unchecked Sendable {
	struct Reply: Sendable {
		var text: String
		var delay: Duration = .zero
		var fails = false
	}

	private let lock = NSLock()
	private let replies: [Reply]
	private(set) var calls: [String?] = []

	init(_ replies: [Reply]) { self.replies = replies }

	func transcribe(wav: Data, language: String?) async throws -> String {
		// The reply belongs to the phrase (its first byte, 1 for the first one submitted), not to the order
		// the calls happen to start in: the queue starts each request as its own concurrent task.
		let index = Int(wav.first ?? 1) - 1
		let reply: Reply = lock.withLock {
			calls.append(language)
			return replies.indices.contains(index) ? replies[index] : Reply(text: "")
		}
		if reply.delay > .zero { try await Task.sleep(for: reply.delay) }
		if reply.fails { throw BackendDictationError() }
		return reply.text
	}
}

@MainActor
@Suite("PhraseTranscriptionQueue")
struct PhraseTranscriptionQueueTests {
	private final class Sink: @unchecked Sendable {
		var texts: [String] = []
		var failures = 0
	}

	private func makeQueue(
		_ replies: [ScriptedTranscriber.Reply], language: String? = nil, requestTimeout: Duration = .seconds(20)
	) -> (PhraseTranscriptionQueue, Sink, ScriptedTranscriber) {
		let sink = Sink()
		let transcriber = ScriptedTranscriber(replies)
		let queue = PhraseTranscriptionQueue(
			transcriber: transcriber, language: language,
			onText: { sink.texts.append($0) }, onFailure: { _ in sink.failures += 1 },
			requestTimeout: requestTimeout)
		return (queue, sink, transcriber)
	}

	// These tests are about what is delivered, not about giving up, so the give-up timeout is far
	// away: at 5 s a main actor held up by other suites let `drain` cancel phrases still in flight.
	@Test func deliversInSpeakingOrderEvenWhenARequestFinishesLate() async {
		let (queue, sink, _) = makeQueue([
			.init(text: "first", delay: .milliseconds(150)),
			.init(text: "second"),
		])
		queue.submit(wav: Data([1]))
		queue.submit(wav: Data([2]))
		await queue.drain(timeout: .seconds(300))
		#expect(sink.texts == ["first", "first second"])
		#expect(queue.text == "first second")
	}

	@Test func sendsTheLanguageHint() async {
		let (queue, _, transcriber) = makeQueue([.init(text: "hej")], language: "da")
		queue.submit(wav: Data([1]))
		await queue.drain(timeout: .seconds(300))
		#expect(transcriber.calls == ["da"])
	}

	@Test func aPhraseWithNoSpeechAddsNothing() async {
		let (queue, sink, _) = makeQueue([.init(text: "  "), .init(text: "hello")])
		queue.submit(wav: Data([1]))
		queue.submit(wav: Data([2]))
		await queue.drain(timeout: .seconds(300))
		#expect(sink.texts == ["hello"])
	}

	@Test func tellsWhenEachPhraseWasAnsweredEvenWithNoText() async {
		let (queue, _, _) = makeQueue([.init(text: "  "), .init(text: "hello"), .init(text: "", fails: true)])
		var answered = 0
		queue.onPhraseDelivered = { answered += 1 }
		queue.submit(wav: Data([1]))
		queue.submit(wav: Data([2]))
		queue.submit(wav: Data([3]))
		await queue.drain(timeout: .seconds(300))
		#expect(answered == 2)
	}

	@Test func tellsWhetherTheLatestAnswerHadWords() async {
		let (queue, _, _) = makeQueue([.init(text: "hello"), .init(text: "  ")])
		var emptyWhenAnswered: [Bool] = []
		queue.onPhraseDelivered = { emptyWhenAnswered.append(queue.lastAnswerWasEmpty) }
		queue.submit(wav: Data([1]))
		queue.submit(wav: Data([2]))
		await queue.drain(timeout: .seconds(300))
		#expect(emptyWhenAnswered == [false, true])
		#expect(queue.submitted == 2)
	}

	@Test func aFailureStopsDeliveryAndReportsOnce() async {
		let (queue, sink, _) = makeQueue([
			.init(text: "ok"), .init(text: "", fails: true), .init(text: "never seen"),
		])
		queue.submit(wav: Data([1]))
		queue.submit(wav: Data([2]))
		queue.submit(wav: Data([3]))
		await queue.drain(timeout: .seconds(300))
		#expect(sink.texts == ["ok"])
		#expect(sink.failures == 1)
		#expect(queue.hasFailed)
		queue.submit(wav: Data([4]))
		await queue.drain(timeout: .seconds(300))
		#expect(sink.failures == 1)
	}

	@Test func cancelDropsWhatIsStillInFlight() async {
		let (queue, sink, _) = makeQueue([.init(text: "late", delay: .seconds(30))])
		queue.submit(wav: Data([1]))
		queue.cancel()
		await queue.drain(timeout: .seconds(300))
		#expect(sink.texts.isEmpty)
		#expect(sink.failures == 0)
	}

	@Test func aRequestThatHangsFailsAfterTheRequestTimeout() async {
		let (queue, sink, _) = makeQueue([.init(text: "stuck", delay: .seconds(60))], requestTimeout: .milliseconds(100))
		queue.submit(wav: Data([1]))
		await queue.drain(timeout: .seconds(300))
		#expect(sink.texts.isEmpty)
		#expect(sink.failures == 1)
		#expect(queue.hasFailed)
	}

	@Test func aRequestThatAnswersInTimeIsNotTimedOut() async {
		let (queue, sink, _) = makeQueue([.init(text: "hej", delay: .milliseconds(20))], requestTimeout: .seconds(30))
		queue.submit(wav: Data([1]))
		await queue.drain(timeout: .seconds(300))
		#expect(sink.texts == ["hej"])
		#expect(sink.failures == 0)
	}

	@Test func drainGivesUpOnARequestThatNeverReturns() async {
		let (queue, sink, _) = makeQueue([.init(text: "stuck", delay: .seconds(60))])
		queue.submit(wav: Data([1]))
		await queue.drain(timeout: .milliseconds(100))
		#expect(sink.texts.isEmpty)
	}
}

@Suite("DictationFallback")
struct DictationFallbackTests {
	@Test func aServerStatusIsNamedInThePlainNote() {
		let note = DictationFallback.failed(BackendDictationError(status: 503)).note
		#expect(note == "Dictating on the phone (the speech service isn't answering, 503)")
		#expect(DictationFallback.failed(BackendDictationError(status: 429)).note.contains("busy"))
		#expect(DictationFallback.failed(BackendDictationError(status: 418)).note.contains("418"))
	}

	@Test func aFailureWithoutAnAnswerSaysSo() {
		let offline = DictationFallback.failed(URLError(.notConnectedToInternet))
		#expect(offline.note.contains("no answer from the server"))
		#expect(offline.detail.contains("NSURLErrorDomain"))
	}

	@Test func aTimeoutAndTheTimeLimitHaveTheirOwnReasons() {
		let timedOut = DictationFallback.failed(TranscriptionTimeout())
		#expect(timedOut == .requestTimedOut)
		#expect(timedOut.note == "Dictating on the phone (the server took too long)")
		#expect(timedOut.detail == "request timed out")
		#expect(DictationFallback.timeLimit.note.hasPrefix("Dictating on the phone ("))
		#expect(DictationFallback.serverNote == "Dictating with the Maskin server")
	}

	@Test func aMissingServiceIsNamedNotSilent() {
		#expect(DictationFallback.serviceMissing.note == "Dictating on the phone (the app isn't connected to the server)")
		#expect(DictationFallback.serviceMissing.detail == "no server dictation service configured")
	}

	@Test func theLogDetailKeepsTheStatusAndNoText() {
		#expect(DictationFallback.failed(BackendDictationError(status: 402)).detail == "request failed: HTTP 402")
		#expect(DictationFallback.engineChanged.detail == "audio engine configuration changed")
		#expect(DictationFallback.microphoneStart("no input").note.contains("microphone"))
	}
}
