#if os(iOS)
import AVFoundation
import Foundation
import MaskinCore
import Speech

/// One dictation session through the Maskin server: the microphone is cut into phrases at pauses
/// (the same rules as the web app), each phrase goes to `POST /api/transcriptions` while the person
/// keeps talking, and the text comes back in speaking order. `Dictation` owns it and takes over
/// with the phone's recogniser when it reports a failure or reaches the time limit.
///
/// While the person talks, the same microphone buffers also go to an on-device recogniser, one task per
/// phrase, only to show grey live words (`PhrasePreviews`). The server's text replaces them phrase by phrase.
@MainActor
final class BackendDictationRun {
	/// The route takes about three minutes of audio per session (the web app stops at the same point).
	static let maxDuration: Duration = .seconds(180)
	/// How long Done waits for the last phrases before giving up on them.
	static let finishTimeout: Duration = .seconds(10)

	/// Built in `start()`, once the audio session is active, like the phone recogniser's engine: one made
	/// earlier is set up for whatever the session was before and can report a configuration change at once.
	private var engine: AVAudioEngine?
	private let queue: PhraseTranscriptionQueue
	private let onFailure: @MainActor (DictationFallback) -> Void
	private let onInterrupted: @MainActor () -> Void
	private let onLimit: @MainActor () -> Void
	private var capture: PhraseCapture?
	private var consumer: Task<Void, Never>?
	private var timer: Task<Void, Never>?
	private var watchers: [Task<Void, Never>] = []
	private let previewRecognizer: SFSpeechRecognizer?
	private let onPreview: @MainActor (String) -> Void
	private var previews = PhrasePreviews()
	private var preview: PreviewFeed?
	private var cancelled = false

	/// What the server has transcribed so far.
	var text: String { queue.text }
	/// The grey words still waiting for the server's text.
	var previewText: String { previews.text }

	init(
		service: any SpeechTranscribing, language: String?,
		previewRecognizer: SFSpeechRecognizer?,
		onText: @escaping @MainActor (String) -> Void,
		onPreview: @escaping @MainActor (String) -> Void,
		onFailure: @escaping @MainActor (DictationFallback) -> Void,
		onInterrupted: @escaping @MainActor () -> Void,
		onLimit: @escaping @MainActor () -> Void
	) {
		queue = PhraseTranscriptionQueue(
			transcriber: service, language: language, onText: onText, onFailure: { onFailure(.failed($0)) })
		self.onFailure = onFailure
		self.onInterrupted = onInterrupted
		self.onLimit = onLimit
		self.previewRecognizer = previewRecognizer
		self.onPreview = onPreview
		queue.onPhraseDelivered = { [weak self] in
			self?.previews.serverDelivered()
			self?.reportPreview()
		}
	}

	/// Opens the microphone. Throws when there is no input or the engine won't start.
	func start() throws {
		let session = AVAudioSession.sharedInstance()
		try session.setCategory(.record, mode: .measurement, options: .duckOthers)
		try session.setActive(true, options: .notifyOthersOnDeactivation)
		let engine = AVAudioEngine()
		self.engine = engine
		let input = engine.inputNode
		let format = input.outputFormat(forBus: 0)
		guard format.sampleRate > 0, format.channelCount > 0 else { throw CaptureError.noInput }
		let (phrases, continuation) = AsyncStream.makeStream(of: Data.self)
		let preview = previewRecognizer.map { PreviewFeed(recognizer: $0, report: Self.makeReporter(self)) }
		self.preview = preview
		let capture = try PhraseCapture(inputFormat: format, phrases: continuation, preview: preview)
		self.capture = capture
		input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.makeTap(capture))
		engine.prepare()
		try engine.start()
		let queue = self.queue
		consumer = Task {
			for await wav in phrases { queue.submit(wav: wav) }
		}
		timer = Task { [weak self] in
			try? await Task.sleep(for: Self.maxDuration)
			guard !Task.isCancelled else { return }
			self?.onLimit()
		}
		watchers = [
			Task { @MainActor [weak self] in
				for await _ in NotificationCenter.default.notifications(
					named: .AVAudioEngineConfigurationChange, object: engine
				).map({ _ in () }) {
					self?.onFailure(.engineChanged)
				}
			},
			Task { @MainActor [weak self] in
				for await _ in NotificationCenter.default.notifications(
					named: AVAudioSession.interruptionNotification
				).map({ _ in () }) {
					self?.onInterrupted()
				}
			},
		]
	}

	/// Done: closes the microphone, sends the last phrase and waits (a few seconds at most) for the
	/// text that is still on its way.
	func finish() async {
		closeMicrophone()
		await consumer?.value
		await queue.drain(timeout: Self.finishTimeout)
	}

	/// Discard, or a failure: closes the microphone and drops everything still in flight.
	func cancel() {
		cancelled = true
		closeMicrophone()
		preview?.cancel()
		consumer?.cancel()
		queue.cancel()
	}

	/// The session is over but the run is kept to read its text (the time-limit handover): no more grey
	/// words, however late the recogniser answers.
	func dropPreview() {
		cancelled = true
		preview?.cancel()
	}

	private func closeMicrophone() {
		timer?.cancel()
		watchers.forEach { $0.cancel() }
		watchers = []
		if let engine {
			if engine.isRunning { engine.stop() }
			engine.inputNode.removeTap(onBus: 0)
		}
		engine = nil
		capture?.finish()
	}

	private enum CaptureError: Error { case noInput }

	private func apply(_ event: PreviewFeed.Event) {
		switch event {
		case .words(let phrase, let text): previews.update(phrase: phrase, text: text)
		case .closed(let phrase, let sent): previews.close(phrase: phrase, sent: sent)
		}
		reportPreview()
	}

	private func reportPreview() {
		guard !cancelled else { return }
		onPreview(previews.text)
	}

	// Recogniser callbacks come on background queues; built here, where nothing is main-actor-isolated.
	nonisolated private static func makeReporter(_ run: BackendDictationRun) -> @Sendable (PreviewFeed.Event) -> Void {
		{ [weak run] event in Task { @MainActor in run?.apply(event) } }
	}

	// The tap fires on an audio thread; built here, where nothing is main-actor-isolated (Swift 6
	// traps on a main-actor closure that runs elsewhere). Same as `Dictation.makeTap`.
	nonisolated private static func makeTap(_ capture: PhraseCapture) -> AVAudioNodeTapBlock {
		{ buffer, _ in capture.append(buffer) }
	}

	/// Turns microphone buffers into closed phrases. Lives on the audio thread: converts to 16 kHz
	/// mono, runs the pause detector on the level, and yields one WAV per finished phrase.
	private final class PhraseCapture: @unchecked Sendable {
		private let lock = NSLock()
		private let converter: AVAudioConverter
		private let outputFormat: AVAudioFormat
		private let phrases: AsyncStream<Data>.Continuation
		private var segmenter = PhraseSegmenter()
		private var samples: [Float] = []
		/// Milliseconds of audio seen, so pauses are measured in recorded time, not wall time.
		private var clockMs = 0.0
		private var finished = false
		private let preview: PreviewFeed?

		init(inputFormat: AVAudioFormat, phrases: AsyncStream<Data>.Continuation, preview: PreviewFeed?) throws {
			guard
				let output = AVAudioFormat(
					commonFormat: .pcmFormatFloat32, sampleRate: Double(WAVEncoding.sampleRate), channels: 1,
					interleaved: false),
				let converter = AVAudioConverter(from: inputFormat, to: output)
			else { throw CaptureError.noInput }
			self.outputFormat = output
			self.converter = converter
			self.phrases = phrases
			self.preview = preview
		}

		func append(_ buffer: AVAudioPCMBuffer) {
			preview?.append(buffer)
			let converted = convert(buffer)
			guard !converted.isEmpty else { return }
			var phrase: [Float]?
			var closedPhrase = false
			lock.lock()
			if !finished {
				samples.append(contentsOf: converted)
				clockMs += Double(converted.count) * 1000 / Double(WAVEncoding.sampleRate)
				switch segmenter.push(rms: Self.rms(converted), atMs: clockMs) {
				case .cut:
					phrase = samples
					closedPhrase = true
					samples = []
					segmenter.reset(atMs: clockMs)
				case .discard:
					closedPhrase = true
					samples = []
					segmenter.reset(atMs: clockMs)
				case nil:
					break
				}
			}
			lock.unlock()
			if let phrase { phrases.yield(Self.wav(phrase)) }
			if closedPhrase { preview?.closePhrase(sent: phrase != nil) }
		}

		/// The microphone is closed: sends what was said since the last pause, then ends the stream.
		func finish() {
			lock.lock()
			let tail = !finished && segmenter.hasVoice ? samples : []
			finished = true
			samples = []
			lock.unlock()
			if !tail.isEmpty { phrases.yield(Self.wav(tail)) }
			preview?.finish(sent: !tail.isEmpty)
			phrases.finish()
		}

		private static func wav(_ samples: [Float]) -> Data {
			WAVEncoding.wav(pcm16: WAVEncoding.pcm16(from: samples))
		}

		private static func rms(_ samples: [Float]) -> Double {
			var sum = 0.0
			for sample in samples { sum += Double(sample) * Double(sample) }
			return (sum / Double(samples.count)).squareRoot()
		}

		private func convert(_ buffer: AVAudioPCMBuffer) -> [Float] {
			let ratio = outputFormat.sampleRate / buffer.format.sampleRate
			let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
			guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return [] }
			let supply = Supply(buffer)
			var error: NSError?
			_ = converter.convert(to: output, error: &error) { count, status in supply.next(count, status) }
			guard error == nil, let channel = output.floatChannelData else { return [] }
			return Array(UnsafeBufferPointer(start: channel[0], count: Int(output.frameLength)))
		}

		/// Hands the converter its one buffer, then says there is no more for now.
		private final class Supply: @unchecked Sendable {
			private var buffer: AVAudioPCMBuffer?
			init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
			func next(_ count: AVAudioPacketCount, _ status: UnsafeMutablePointer<AVAudioConverterInputStatus>)
				-> AVAudioBuffer?
			{
				guard let buffer else {
					status.pointee = .noDataNow
					return nil
				}
				self.buffer = nil
				status.pointee = .haveData
				return buffer
			}
		}
	}

	/// Feeds the microphone to the phone's recogniser for the grey live words. One recognition task per
	/// phrase, started and ended where `PhraseCapture` cuts the phrase for the server, so a task's words
	/// belong to exactly one phrase. On-device only: the audio goes nowhere new. Lives on the audio thread.
	private final class PreviewFeed: @unchecked Sendable {
		enum Event: Sendable {
			case words(phrase: Int, text: String)
			case closed(phrase: Int, sent: Bool)
		}

		private let lock = NSLock()
		private let recognizer: SFSpeechRecognizer
		private let report: @Sendable (Event) -> Void
		private var request: SFSpeechAudioBufferRecognitionRequest?
		private var tasks: [SFSpeechRecognitionTask] = []
		private var phrase = 0
		private var finished = false

		init(recognizer: SFSpeechRecognizer, report: @escaping @Sendable (Event) -> Void) {
			self.recognizer = recognizer
			self.report = report
			request = startTask()
		}

		func append(_ buffer: AVAudioPCMBuffer) {
			lock.lock()
			let current = request
			lock.unlock()
			current?.append(buffer)
		}

		/// The phrase was cut: ends its task and starts the next one.
		func closePhrase(sent: Bool) {
			lock.lock()
			guard !finished else {
				lock.unlock()
				return
			}
			let closed = phrase
			request?.endAudio()
			phrase += 1
			request = startTask()
			lock.unlock()
			report(.closed(phrase: closed, sent: sent))
		}

		/// The microphone is closed: ends the current task; no new one starts.
		func finish(sent: Bool) {
			lock.lock()
			guard !finished else {
				lock.unlock()
				return
			}
			finished = true
			let closed = phrase
			request?.endAudio()
			request = nil
			lock.unlock()
			report(.closed(phrase: closed, sent: sent))
		}

		/// Discard or a failure: nothing more is reported.
		func cancel() {
			lock.lock()
			finished = true
			request?.endAudio()
			request = nil
			let running = tasks
			tasks = []
			lock.unlock()
			running.forEach { $0.cancel() }
		}

		/// Called with the lock held.
		private func startTask() -> SFSpeechAudioBufferRecognitionRequest {
			// One task per phrase adds up over a long session: let go of the ones that are done.
			tasks.removeAll { $0.state == .completed || $0.state == .canceling }
			let request = SFSpeechAudioBufferRecognitionRequest()
			request.shouldReportPartialResults = true
			request.taskHint = .dictation
			request.addsPunctuation = true
			request.requiresOnDeviceRecognition = true
			let id = phrase
			let report = report
			let task = recognizer.recognitionTask(with: request) { result, _ in
				if let text = result?.bestTranscription.formattedString { report(.words(phrase: id, text: text)) }
			}
			tasks.append(task)
			return request
		}
	}
}
#endif
