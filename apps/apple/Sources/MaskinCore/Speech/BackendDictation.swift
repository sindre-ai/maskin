import Foundation

/// Speech to text on the Maskin server (`POST /api/transcriptions`), as a seam so dictation logic
/// tests without a network.
public protocol SpeechTranscribing: Sendable {
	/// Text for one WAV recording (16 kHz mono). Empty when no speech was heard. `language` is an
	/// optional hint such as "da" or "en".
	func transcribe(wav: Data, language: String?) async throws -> String
}

/// Where the dictation code finds the server service. Set once by the real app wiring; nil in
/// previews and tests, which dictate on the phone.
@MainActor
public enum DictationBackend {
	public static var service: (any SpeechTranscribing)?
}

public enum DictationLanguage {
	/// The language hint to send: the first entry of the phone's language order, as a bare code
	/// ("da-DK" gives "da"). Nil when it isn't a plain two or three letter code, so the route's
	/// hint check can't reject the request.
	public static func hint(preferredLanguages: [String]) -> String? {
		guard let first = preferredLanguages.first else { return nil }
		let code = first.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map { $0.lowercased() } ?? ""
		guard (2...3).contains(code.count), code.allSatisfy({ $0 >= "a" && $0 <= "z" }) else { return nil }
		return code
	}
}

/// Sends dictated phrases to the server as they close and hands the text back in speaking order,
/// even when the requests finish out of order. After the first failed request nothing more is
/// delivered (a later phrase would otherwise land after a gap) and `onFailure` fires once.
@MainActor
public final class PhraseTranscriptionQueue {
	/// What has been delivered so far, phrases joined with spaces.
	public private(set) var text = ""
	public private(set) var hasFailed = false

	private let transcriber: any SpeechTranscribing
	private let language: String?
	private let onText: @MainActor (String) -> Void
	private let onFailure: @MainActor (Error) -> Void
	private var requests: [Task<String, Error>] = []
	private var tail: Task<Void, Never>?
	private var cancelled = false

	public init(
		transcriber: any SpeechTranscribing, language: String?,
		onText: @escaping @MainActor (String) -> Void,
		onFailure: @escaping @MainActor (Error) -> Void
	) {
		self.transcriber = transcriber
		self.language = language
		self.onText = onText
		self.onFailure = onFailure
	}

	/// Starts transcribing one phrase now. Its text is delivered once every earlier phrase has been.
	public func submit(wav: Data) {
		guard !cancelled, !hasFailed else { return }
		let transcriber = transcriber
		let language = language
		let request = Task { try await transcriber.transcribe(wav: wav, language: language) }
		requests.append(request)
		let previous = tail
		tail = Task { [weak self] in
			let result = await request.result
			await previous?.value
			self?.deliver(result)
		}
	}

	/// Waits for every submitted phrase to be delivered. Gives up after `timeout`: what is still in
	/// flight is dropped, as with `cancel()`.
	public func drain(timeout: Duration) async {
		guard let tail else { return }
		let timer = Task { [weak self] in
			try await Task.sleep(for: timeout)
			self?.cancel()
		}
		await tail.value
		timer.cancel()
	}

	/// Drops everything in flight; nothing more is delivered.
	public func cancel() {
		cancelled = true
		for request in requests { request.cancel() }
	}

	private func deliver(_ result: Result<String, Error>) {
		guard !cancelled, !hasFailed else { return }
		switch result {
		case .success(let phrase):
			let merged = DictationText.merge(base: text, transcript: phrase)
			guard merged != text else { return }
			text = merged
			onText(text)
		case .failure(let error):
			hasFailed = true
			onFailure(error)
		}
	}
}
