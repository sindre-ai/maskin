import Foundation
import MaskinAPI

/// The server refused or could not finish a transcription (any answer other than 200).
public struct BackendDictationError: Error, Equatable, Sendable {
	/// The HTTP status the server answered with.
	public let status: Int?

	public init(status: Int? = nil) {
		self.status = status
	}
}

/// `POST /api/transcriptions` on the generated client. The generated operation names stop here; the
/// rest of the app sees `SpeechTranscribing`.
public struct APIBackendDictation: SpeechTranscribing {
	private let client: Client

	public init(client: Client) {
		self.client = client
	}

	public func transcribe(wav: Data, language: String?) async throws -> String {
		let body = Components.Schemas.TranscribeBody(audio: wav.base64EncodedString(), language: language)
		let output = try await client.post_sol_api_sol_transcriptions(
			Operations.post_sol_api_sol_transcriptions.Input(body: .json(body)))
		switch output {
		case .ok(let ok): return try ok.body.json.text
		case .badRequest: throw BackendDictationError(status: 400)
		case .contentTooLarge: throw BackendDictationError(status: 413)
		case .tooManyRequests: throw BackendDictationError(status: 429)
		case .internalServerError: throw BackendDictationError(status: 500)
		case .badGateway: throw BackendDictationError(status: 502)
		case .serviceUnavailable: throw BackendDictationError(status: 503)
		case .undocumented(let status, _): throw BackendDictationError(status: status)
		}
	}
}
