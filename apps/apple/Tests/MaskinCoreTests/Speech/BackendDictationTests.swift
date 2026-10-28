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
	private var replies: [Reply]
	private(set) var calls: [String?] = []

	init(_ replies: [Reply]) { self.replies = replies }

	func transcribe(wav: Data, language: String?) async throws -> String {
		let reply: Reply = lock.withLock {
			calls.append(language)
			return replies.isEmpty ? Reply(text: "") : replies.removeFirst()
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

	private func makeQueue(_ replies: [ScriptedTranscriber.Reply], language: String? = nil)
		-> (PhraseTranscriptionQueue, Sink, ScriptedTranscriber)
	{
		let sink = Sink()
		let transcriber = ScriptedTranscriber(replies)
		let queue = PhraseTranscriptionQueue(
			transcriber: transcriber, language: language,
			onText: { sink.texts.append($0) }, onFailure: { _ in sink.failures += 1 })
		return (queue, sink, transcriber)
	}

	@Test func deliversInSpeakingOrderEvenWhenARequestFinishesLate() async {
		let (queue, sink, _) = makeQueue([
			.init(text: "first", delay: .milliseconds(150)),
			.init(text: "second"),
		])
		queue.submit(wav: Data([1]))
		queue.submit(wav: Data([2]))
		await queue.drain(timeout: .seconds(5))
		#expect(sink.texts == ["first", "first second"])
		#expect(queue.text == "first second")
	}

	@Test func sendsTheLanguageHint() async {
		let (queue, _, transcriber) = makeQueue([.init(text: "hej")], language: "da")
		queue.submit(wav: Data([1]))
		await queue.drain(timeout: .seconds(5))
		#expect(transcriber.calls == ["da"])
	}

	@Test func aPhraseWithNoSpeechAddsNothing() async {
		let (queue, sink, _) = makeQueue([.init(text: "  "), .init(text: "hello")])
		queue.submit(wav: Data([1]))
		queue.submit(wav: Data([2]))
		await queue.drain(timeout: .seconds(5))
		#expect(sink.texts == ["hello"])
	}

	@Test func aFailureStopsDeliveryAndReportsOnce() async {
		let (queue, sink, _) = makeQueue([
			.init(text: "ok"), .init(text: "", fails: true), .init(text: "never seen"),
		])
		queue.submit(wav: Data([1]))
		queue.submit(wav: Data([2]))
		queue.submit(wav: Data([3]))
		await queue.drain(timeout: .seconds(5))
		#expect(sink.texts == ["ok"])
		#expect(sink.failures == 1)
		#expect(queue.hasFailed)
		queue.submit(wav: Data([4]))
		await queue.drain(timeout: .seconds(5))
		#expect(sink.failures == 1)
	}

	@Test func cancelDropsWhatIsStillInFlight() async {
		let (queue, sink, _) = makeQueue([.init(text: "late", delay: .seconds(30))])
		queue.submit(wav: Data([1]))
		queue.cancel()
		await queue.drain(timeout: .seconds(5))
		#expect(sink.texts.isEmpty)
		#expect(sink.failures == 0)
	}

	@Test func drainGivesUpOnARequestThatNeverReturns() async {
		let (queue, sink, _) = makeQueue([.init(text: "stuck", delay: .seconds(60))])
		queue.submit(wav: Data([1]))
		await queue.drain(timeout: .milliseconds(100))
		#expect(sink.texts.isEmpty)
	}
}
