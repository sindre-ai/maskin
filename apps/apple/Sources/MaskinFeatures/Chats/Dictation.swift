import Foundation
import MaskinCore
import Observation

#if os(iOS)
import AVFoundation
import Speech

/// Live dictation into the composer. Prefers on-device recognition (no audio leaves the phone);
/// when the device or language can't, the system's recogniser is used instead.
///
/// Needs `NSSpeechRecognitionUsageDescription` and `NSMicrophoneUsageDescription` in Info.plist.
@MainActor
@Observable
final class Dictation {
	enum State: Equatable {
		case idle
		case listening
		/// Permission refused or the recogniser is unavailable; the string says what to do.
		case unavailable(String)
	}

	private(set) var state: State = .idle
	var isListening: Bool { state == .listening }

	/// Built per session: an engine kept across sessions holds a stale input format once the audio
	/// session has been deactivated or the route changed, and the tap then fails or delivers nothing.
	@ObservationIgnored private var engine: AVAudioEngine?
	@ObservationIgnored private var task: SFSpeechRecognitionTask?
	@ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
	@ObservationIgnored private var onText: (@MainActor (String) -> Void)?
	/// Bumped on every start and stop, so a cancelled task's late callback can't end a newer session.
	@ObservationIgnored private var generation = 0
	@ObservationIgnored private var continuous = false
	@ObservationIgnored private var accumulator = DictationAccumulator()
	@ObservationIgnored private var restartPolicy = DictationRestartPolicy()
	@ObservationIgnored private var taskStartedAt = Date()
	@ObservationIgnored private var heardText = false
	/// The microphone is closed (Done) but the recogniser is still turning the last audio into text.
	@ObservationIgnored private var flushing = false
	@ObservationIgnored private var feed: AudioFeed?
	@ObservationIgnored private var watchers: [Task<Void, Never>] = []

	/// Start listening; `onText` gets the running transcript (the whole utterance so far).
	///
	/// `continuous` keeps recording across the recogniser ending on a pause, until `stop()`: the
	/// transcript then accumulates across restarts. Without it (a live conversation, which treats
	/// the end of an utterance as a turn) the session ends when the recogniser does.
	func start(continuous: Bool = false, onText: @escaping @MainActor (String) -> Void) async {
		guard state != .listening else { return }
		if flushing { finishFlush() }
		self.onText = onText
		self.continuous = continuous
		accumulator = DictationAccumulator()
		restartPolicy = DictationRestartPolicy()
		guard await requestPermissions() else { return }
		guard let recognizer = Self.makeRecognizer() else {
			state = .unavailable("Dictation isn't available for this language right now.")
			return
		}
		// The speaker and the microphone never run together.
		SpeechReader.shared.inputDidBegin()
		do {
			try launch(recognizer)
			state = .listening
		} catch {
			stop()
			state = .unavailable(
				(error as? DictationError)?.message
					?? "Couldn't start the microphone (\(error.localizedDescription)).")
		}
	}

	private static func makeRecognizer() -> SFSpeechRecognizer? {
		// The phone's language order, not the app's region: a Danish keyboard on an English-region
		// phone must dictate Danish. The first language the recogniser supports wins.
		let locales = Locale.preferredLanguages.map(Locale.init(identifier:)) + [Locale.current]
		for locale in locales {
			if let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable { return recognizer }
		}
		if let recognizer = SFSpeechRecognizer(), recognizer.isAvailable { return recognizer }
		return nil
	}

	/// Builds the engine and the first recognition task. Called again when the engine itself has to go
	/// (a route change, an interruption); a recogniser that merely ended only gets `startTask`.
	private func launch(_ recognizer: SFSpeechRecognizer) throws {
		let session = AVAudioSession.sharedInstance()
		try session.setCategory(.record, mode: .measurement, options: .duckOthers)
		try session.setActive(true, options: .notifyOthersOnDeactivation)
		let engine = AVAudioEngine()
		let feed = AudioFeed()
		self.engine = engine
		self.feed = feed
		let input = engine.inputNode
		let format = input.outputFormat(forBus: 0)
		guard format.sampleRate > 0, format.channelCount > 0 else { throw DictationError.noInput }
		input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.makeTap(feed))
		startTask(recognizer)
		engine.prepare()
		try engine.start()
		watch(engine)
	}

	/// A fresh request and task on the running engine. The tap keeps feeding, now into the new
	/// request, so nothing said between two tasks is lost.
	private func startTask(_ recognizer: SFSpeechRecognizer) {
		let request = SFSpeechAudioBufferRecognitionRequest()
		request.shouldReportPartialResults = true
		request.taskHint = .dictation
		request.addsPunctuation = true
		request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
		self.request = request
		feed?.set(request)
		generation += 1
		let current = generation
		taskStartedAt = Date()
		heardText = false
		task = recognizer.recognitionTask(
			with: request,
			resultHandler: Self.makeHandler { [weak self] text, finished, error in
				Task { @MainActor in
					guard let self, self.generation == current else { return }
					if let text {
						self.heardText = self.heardText || !text.isEmpty
						self.accumulator.update(text)
						self.onText?(self.accumulator.text)
					}
					guard finished else { return }
					if self.flushing {
						self.finishFlush()
					} else {
						self.taskEnded(error: error, hadText: text != nil)
					}
				}
			})
	}

	/// Route changes and interruptions stop the engine without telling the recogniser. Without this
	/// the session stays "listening" and hears nothing.
	private func watch(_ engine: AVAudioEngine) {
		watchers.forEach { $0.cancel() }
		watchers = [
			Task { @MainActor [weak self] in
				for await _ in NotificationCenter.default.notifications(
					named: .AVAudioEngineConfigurationChange, object: engine
				).map({ _ in () }) {
					self?.engineChanged()
				}
			},
			Task { @MainActor [weak self] in
				for await _ in NotificationCenter.default.notifications(
					named: AVAudioSession.interruptionNotification
				).map({ _ in () }) {
					self?.fail("Dictation was interrupted. Tap the microphone to continue.")
				}
			},
		]
	}

	private func engineChanged() {
		guard state == .listening, !flushing else { return }
		let decision = restartPolicy.taskEnded(
			ranFor: Date().timeIntervalSince(taskStartedAt), heardText: heardText, fatal: false)
		guard decision == .restart, let recognizer = Self.makeRecognizer() else {
			fail("Dictation stopped: the microphone keeps changing. Tap the microphone to try again.")
			return
		}
		accumulator.roll()
		teardownAudio()
		do {
			try launch(recognizer)
		} catch {
			fail("Dictation stopped: \(error.localizedDescription)")
		}
	}

	/// Ends the session and says why, so a stop is never silent.
	private func fail(_ message: String) {
		stop()
		state = .unavailable(message)
	}

	private func finishFlush() {
		flushing = false
		generation += 1
		task?.cancel()
		task = nil
		request = nil
	}

	/// The recogniser finished (a pause, its time limit, or an error). Continuous dictation starts
	/// a fresh task, keeping the text so far; anything else ends the session.
	private func taskEnded(error: Error?, hadText: Bool) {
		let message = error.flatMap { Self.message(for: $0) }
		if continuous {
			let decision = restartPolicy.taskEnded(
				ranFor: Date().timeIntervalSince(taskStartedAt), heardText: heardText,
				fatal: message != nil)
			if decision == .restart, let recognizer = Self.makeRecognizer() {
				accumulator.roll()
				if engine?.isRunning == true {
					task?.cancel()
					startTask(recognizer)
					return
				}
				teardownAudio()
				do {
					try launch(recognizer)
					return
				} catch {
					fail("Dictation stopped: \(error.localizedDescription)")
					return
				}
			}
			if decision == .stop, message == nil {
				fail("Dictation stopped: the speech recogniser isn't responding. Tap the microphone to try again.")
				return
			}
		}
		stop()
		if let message { state = .unavailable(message) }
	}

	// The audio tap and the recogniser's callback fire on background queues. Closures written inside
	// this @MainActor class would be inferred main-actor-isolated, and Swift 6 traps when they run
	// anywhere else — so they are built here, where nothing is isolated.
	nonisolated private static func makeTap(_ feed: AudioFeed) -> AVAudioNodeTapBlock {
		{ buffer, _ in feed.append(buffer) }
	}

	nonisolated private static func makeHandler(
		_ deliver: @escaping @Sendable (String?, Bool, Error?) -> Void
	) -> @Sendable (SFSpeechRecognitionResult?, Error?) -> Void {
		{ result, error in
			deliver(
				result?.bestTranscription.formattedString, result?.isFinal == true || error != nil, error)
		}
	}

	private enum DictationError: Error {
		case noInput
		var message: String { "No microphone input is available right now." }
	}

	/// What to tell the user for a recogniser error; nil for the ones that aren't failures
	/// (cancelled by us, or nothing was said).
	private static func message(for error: Error) -> String? {
		let ns = error as NSError
		if ns.domain == "kAFAssistantErrorDomain", [216, 301, 1110].contains(ns.code) { return nil }
		if ns.domain == "kLSRErrorDomain", ns.code == 301 { return nil }
		return "Dictation stopped: \(ns.localizedDescription)"
	}

	/// TCC calls the completion on a background queue. Written here, in a nonisolated context, the
	/// closure isn't inferred main-actor-isolated (which Swift 6 traps on when it runs off-main).
	nonisolated private static func speechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
		await withCheckedContinuation { continuation in
			SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
		}
	}

	/// Releases the engine, request and task of the current recognition without ending the session.
	private func teardownAudio() {
		generation += 1
		flushing = false
		watchers.forEach { $0.cancel() }
		watchers = []
		feed = nil
		if let engine {
			if engine.isRunning { engine.stop() }
			engine.inputNode.removeTap(onBus: 0)
		}
		engine = nil
		request?.endAudio()
		task?.cancel()
		task = nil
		request = nil
	}

	/// `flush` is for Done: the microphone closes now, but the recogniser gets a moment to deliver the
	/// words it was still working on. Without it the last second or two of speech is dropped.
	func stop(flush: Bool = false) {
		if flush, state == .listening, request != nil {
			watchers.forEach { $0.cancel() }
			watchers = []
			if let engine {
				if engine.isRunning { engine.stop() }
				engine.inputNode.removeTap(onBus: 0)
			}
			engine = nil
			feed = nil
			request?.endAudio()
			flushing = true
			let current = generation
			state = .idle
			try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
			SpeechReader.shared.inputDidEnd()
			Task { @MainActor [weak self] in
				try? await Task.sleep(for: .seconds(2))
				if let self, self.flushing, self.generation == current { self.finishFlush() }
			}
			return
		}
		teardownAudio()
		try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
		if state == .listening { state = .idle }
		SpeechReader.shared.inputDidEnd()
	}

	func clearError() {
		if case .unavailable = state { state = .idle }
	}

	private func requestPermissions() async -> Bool {
		let speech = await Self.speechAuthorization()
		guard speech == .authorized else {
			state = .unavailable("Allow Speech Recognition in Settings to dictate.")
			return false
		}
		let mic = await AVAudioApplication.requestRecordPermission()
		guard mic else {
			state = .unavailable("Allow Microphone access in Settings to dictate.")
			return false
		}
		return true
	}

	/// The tap runs on the audio thread; the request it appends to is swapped when a task restarts.
	private final class AudioFeed: @unchecked Sendable {
		private let lock = NSLock()
		private var request: SFSpeechAudioBufferRecognitionRequest?
		func set(_ new: SFSpeechAudioBufferRecognitionRequest) {
			lock.lock()
			request = new
			lock.unlock()
		}
		func append(_ buffer: AVAudioPCMBuffer) {
			lock.lock()
			let current = request
			lock.unlock()
			current?.append(buffer)
		}
	}
}
#endif
