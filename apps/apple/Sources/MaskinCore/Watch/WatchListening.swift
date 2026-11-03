import Foundation
import Observation

/// Live listening on the wrist: the wearer taps the microphone once and talks. The watch listens by
/// itself, sends each phrase to the server's transcription as it closes, and sends the question to
/// the Chief of Staff on a pause or when Done is tapped. When the server can't be reached (weak
/// signal) it steps back to tap to talk, where the system's dictation does the listening.
@MainActor
@Observable
public final class WatchListeningStore {
	public enum Phase: Equatable, Sendable {
		case idle
		case listening
		case sending
		case tapToTalk(Reason)
	}

	/// Why listening handed over to tap to talk.
	public enum Reason: Equatable, Sendable {
		/// No transcription service (signed out).
		case unavailable
		/// The microphone would not open.
		case microphone
		/// The server could not be reached or did not answer.
		case weakSignal
	}

	public private(set) var phase: Phase = .idle
	/// What has been heard so far.
	public private(set) var text = ""

	@ObservationIgnored private let transcriber: (any SpeechTranscribing)?
	@ObservationIgnored private let makeMicrophone: @MainActor () -> any PhraseMicrophone
	@ObservationIgnored private let language: String?
	@ObservationIgnored private let settle: Duration
	@ObservationIgnored private let maxDuration: Duration
	@ObservationIgnored private let drainTimeout: Duration
	/// Gets the finished question; the caller asks the Chief of Staff with it.
	@ObservationIgnored public var deliver: @MainActor (String) -> Void
	@ObservationIgnored private var microphone: (any PhraseMicrophone)?
	@ObservationIgnored private var queue: PhraseTranscriptionQueue?
	@ObservationIgnored private var consumer: Task<Void, Never>?
	@ObservationIgnored private var settleTimer: Task<Void, Never>?
	@ObservationIgnored private var limitTimer: Task<Void, Never>?
	@ObservationIgnored private var run = 0

	/// - Parameters:
	///   - settle: how long a pause after the last heard words must last before the question is sent.
	///   - maxDuration: the longest one listening goes on (the server takes about three minutes; a
	///     wrist question is short).
	///   - deliver: gets the finished question; the caller asks the Chief of Staff with it.
	public init(
		transcriber: (any SpeechTranscribing)?, language: String? = nil,
		settle: Duration = .milliseconds(1400), maxDuration: Duration = .seconds(60),
		drainTimeout: Duration = .seconds(8),
		makeMicrophone: @escaping @MainActor () -> any PhraseMicrophone,
		deliver: @escaping @MainActor (String) -> Void = { _ in }
	) {
		self.transcriber = transcriber
		self.language = language
		self.settle = settle
		self.maxDuration = maxDuration
		self.drainTimeout = drainTimeout
		self.makeMicrophone = makeMicrophone
		self.deliver = deliver
	}

	/// Opens the microphone and starts listening. From tap to talk this is the second try.
	public func begin() {
		switch phase {
		case .listening, .sending: return
		case .idle, .tapToTalk: break
		}
		guard let transcriber else {
			phase = .tapToTalk(.unavailable)
			return
		}
		teardown()
		run += 1
		let current = run
		text = ""
		let mic = makeMicrophone()
		let phrases: AsyncStream<Data>
		do {
			phrases = try mic.start()
		} catch {
			phase = .tapToTalk(.microphone)
			return
		}
		microphone = mic
		let queue = PhraseTranscriptionQueue(
			transcriber: transcriber, language: language,
			onText: { [weak self] heard in self?.heard(heard, run: current) },
			onFailure: { [weak self] _ in self?.failed(run: current) })
		self.queue = queue
		consumer = Task { for await wav in phrases { queue.submit(wav: wav) } }
		limitTimer = Task { [weak self, maxDuration] in
			try? await Task.sleep(for: maxDuration)
			guard !Task.isCancelled else { return }
			await self?.finish(run: current)
		}
		phase = .listening
	}

	/// Done: stops listening and sends what was heard.
	public func done() {
		let current = run
		Task { await finish(run: current) }
	}

	/// Cancel: stops listening and sends nothing.
	public func cancel() {
		teardown()
		run += 1
		text = ""
		phase = .idle
	}

	/// Back to the start, ready for the next question.
	public func reset() { cancel() }

	private func heard(_ heard: String, run current: Int) {
		guard current == run, phase == .listening else { return }
		text = heard
		settleTimer?.cancel()
		settleTimer = Task { [weak self, settle] in
			try? await Task.sleep(for: settle)
			guard !Task.isCancelled else { return }
			await self?.finish(run: current)
		}
	}

	private func failed(run current: Int) {
		guard current == run, phase == .listening else { return }
		let salvaged = text.trimmingCharacters(in: .whitespacesAndNewlines)
		if salvaged.isEmpty {
			teardown()
			phase = .tapToTalk(.weakSignal)
		} else {
			// Part of the question was heard before the line dropped: send that, not nothing.
			Task { await finish(run: current) }
		}
	}

	private func finish(run current: Int) async {
		guard current == run, phase == .listening else { return }
		phase = .sending
		settleTimer?.cancel()
		limitTimer?.cancel()
		microphone?.stop()
		microphone = nil
		await consumer?.value
		await queue?.drain(timeout: drainTimeout)
		guard current == run else { return }
		let spoken = (queue?.text ?? text).trimmingCharacters(in: .whitespacesAndNewlines)
		let lineDropped = queue?.hasFailed ?? false
		teardown()
		if !spoken.isEmpty {
			text = ""
			phase = .idle
			deliver(spoken)
		} else {
			phase = lineDropped ? .tapToTalk(.weakSignal) : .idle
		}
	}

	private func teardown() {
		settleTimer?.cancel()
		limitTimer?.cancel()
		consumer?.cancel()
		queue?.cancel()
		microphone?.stop()
		settleTimer = nil
		limitTimer = nil
		consumer = nil
		queue = nil
		microphone = nil
	}
}
