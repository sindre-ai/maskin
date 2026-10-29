#if os(iOS)
import AVFoundation
import Foundation
import MaskinCore

/// One dictation session through the Maskin server: the microphone is cut into phrases at pauses
/// (the same rules as the web app), each phrase goes to `POST /api/transcriptions` while the person
/// keeps talking, and the text comes back in speaking order. `Dictation` owns it and takes over
/// with the phone's recogniser when it reports a failure or reaches the time limit.
@MainActor
final class BackendDictationRun {
	/// The route takes about three minutes of audio per session (the web app stops at the same point).
	static let maxDuration: Duration = .seconds(180)
	/// How long Done waits for the last phrases before giving up on them.
	static let finishTimeout: Duration = .seconds(10)

	private let engine = AVAudioEngine()
	private let queue: PhraseTranscriptionQueue
	private let onFailure: @MainActor () -> Void
	private let onInterrupted: @MainActor () -> Void
	private let onLimit: @MainActor () -> Void
	private var capture: PhraseCapture?
	private var consumer: Task<Void, Never>?
	private var timer: Task<Void, Never>?
	private var watchers: [Task<Void, Never>] = []

	/// What the server has transcribed so far.
	var text: String { queue.text }

	init(
		service: any SpeechTranscribing, language: String?,
		onText: @escaping @MainActor (String) -> Void,
		onFailure: @escaping @MainActor () -> Void,
		onInterrupted: @escaping @MainActor () -> Void,
		onLimit: @escaping @MainActor () -> Void
	) {
		queue = PhraseTranscriptionQueue(
			transcriber: service, language: language, onText: onText, onFailure: { _ in onFailure() })
		self.onFailure = onFailure
		self.onInterrupted = onInterrupted
		self.onLimit = onLimit
	}

	/// Opens the microphone. Throws when there is no input or the engine won't start.
	func start() throws {
		let session = AVAudioSession.sharedInstance()
		try session.setCategory(.record, mode: .measurement, options: .duckOthers)
		try session.setActive(true, options: .notifyOthersOnDeactivation)
		let input = engine.inputNode
		let format = input.outputFormat(forBus: 0)
		guard format.sampleRate > 0, format.channelCount > 0 else { throw CaptureError.noInput }
		let (phrases, continuation) = AsyncStream.makeStream(of: Data.self)
		let capture = try PhraseCapture(inputFormat: format, phrases: continuation)
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
		let engine = self.engine
		watchers = [
			Task { @MainActor [weak self] in
				for await _ in NotificationCenter.default.notifications(
					named: .AVAudioEngineConfigurationChange, object: engine
				).map({ _ in () }) {
					self?.onFailure()
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
		closeMicrophone()
		consumer?.cancel()
		queue.cancel()
	}

	private func closeMicrophone() {
		timer?.cancel()
		watchers.forEach { $0.cancel() }
		watchers = []
		if engine.isRunning { engine.stop() }
		engine.inputNode.removeTap(onBus: 0)
		capture?.finish()
	}

	private enum CaptureError: Error { case noInput }

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

		init(inputFormat: AVAudioFormat, phrases: AsyncStream<Data>.Continuation) throws {
			guard
				let output = AVAudioFormat(
					commonFormat: .pcmFormatFloat32, sampleRate: Double(WAVEncoding.sampleRate), channels: 1,
					interleaved: false),
				let converter = AVAudioConverter(from: inputFormat, to: output)
			else { throw CaptureError.noInput }
			self.outputFormat = output
			self.converter = converter
			self.phrases = phrases
		}

		func append(_ buffer: AVAudioPCMBuffer) {
			let converted = convert(buffer)
			guard !converted.isEmpty else { return }
			var phrase: [Float]?
			lock.lock()
			if !finished {
				samples.append(contentsOf: converted)
				clockMs += Double(converted.count) * 1000 / Double(WAVEncoding.sampleRate)
				switch segmenter.push(rms: Self.rms(converted), atMs: clockMs) {
				case .cut:
					phrase = samples
					samples = []
					segmenter.reset(atMs: clockMs)
				case .discard:
					samples = []
					segmenter.reset(atMs: clockMs)
				case nil:
					break
				}
			}
			lock.unlock()
			if let phrase { phrases.yield(Self.wav(phrase)) }
		}

		/// The microphone is closed: sends what was said since the last pause, then ends the stream.
		func finish() {
			lock.lock()
			let tail = !finished && segmenter.hasVoice ? samples : []
			finished = true
			samples = []
			lock.unlock()
			if !tail.isEmpty { phrases.yield(Self.wav(tail)) }
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
}
#endif
