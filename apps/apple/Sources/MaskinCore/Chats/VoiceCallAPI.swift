import Foundation
import MaskinAPI

/// What the server hands back for a call's WebRTC offer.
public struct VoiceCallAnswer: Sendable, Equatable {
	public var sdp: String
	/// False when the server could not attach its tool connection; the call still runs, and the
	/// client answers every tool call with "unavailable" so the agent says so.
	public var toolsAvailable: Bool
	public var persistTranscripts: Bool

	public init(sdp: String, toolsAvailable: Bool, persistTranscripts: Bool) {
		self.sdp = sdp
		self.toolsAvailable = toolsAvailable
		self.persistTranscripts = persistTranscripts
	}
}

public enum VoiceCallEndReason: String, Sendable {
	case userHangup = "user_hangup"
	case networkError = "network_error"
}

public enum VoiceCallFailure: Error, Sendable, Equatable {
	/// 404: voice mode is off for this person, or the agent is not in the workspace. The caller
	/// falls back to the dictation-based call.
	case unavailable
	/// 400: the target is not an agent.
	case notAnAgent
	/// 409: this person already has a live call (or the session already took its offer).
	case alreadyInCall
	/// 429: the vendor or the workspace's daily voice minutes are used up.
	case rateLimited(retryAfterSeconds: Int?)
	case server(String)
	case network(String)

	/// What to show on the call screen.
	public var message: String {
		switch self {
		case .unavailable: return "Voice calls aren't available right now."
		case .notAnAgent: return "That isn't an agent, so it can't take a call."
		case .alreadyInCall: return "You're already in a call. End it and try again."
		case .rateLimited: return "Voice minutes are used up for today. Try again later."
		case .server(let text), .network(let text): return text
		}
	}

	/// Failures where the dictation-based call still works, so the caller should use it instead.
	public var shouldFallBack: Bool {
		switch self {
		case .unavailable, .notAnAgent: return true
		default: return false
		}
	}
}

/// The three calls a Realtime voice call makes, as a seam so the call logic tests without a server.
public protocol VoiceCalling: Sendable {
	/// Reserves the caller's live-call slot for this agent. Returns the voice session id.
	func create(agentActorID: String) async throws -> String
	func offer(voiceSessionID: String, sdp: String) async throws -> VoiceCallAnswer
	/// Ends the call. Idempotent on the server. Returns the id of the conversation the transcript
	/// was saved to, if any.
	@discardableResult
	func hangup(
		voiceSessionID: String, reason: VoiceCallEndReason, inputAudioSeconds: Int,
		outputAudioSeconds: Int
	) async throws -> String?
}

/// `/api/voice-sessions` over plain `URLSession`. Written by hand because the routes are not yet in
/// the checked-in OpenAPI snapshot; once they are, this can sit on the generated client.
public struct URLSessionVoiceCalls: VoiceCalling {
	private let baseURL: URL
	private let clientSource: String
	private let credentials: MaskinCredentialsProvider
	private let session: URLSession

	public init(
		baseURL: URL, clientSource: String, credentials: @escaping MaskinCredentialsProvider,
		session: URLSession = .shared
	) {
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.credentials = credentials
		self.session = session
	}

	public func create(agentActorID: String) async throws -> String {
		let data = try await post("voice-sessions", body: ["agent_actor_id": agentActorID])
		struct Created: Decodable { let voice_session_id: String }
		return try decode(Created.self, from: data).voice_session_id
	}

	public func offer(voiceSessionID: String, sdp: String) async throws -> VoiceCallAnswer {
		let data = try await post("voice-sessions/\(voiceSessionID)/offer", body: ["sdp": sdp])
		struct Answer: Decodable {
			let sdp: String
			let tools_available: Bool
			let persist_transcripts: Bool
		}
		let answer = try decode(Answer.self, from: data)
		return VoiceCallAnswer(
			sdp: answer.sdp, toolsAvailable: answer.tools_available,
			persistTranscripts: answer.persist_transcripts)
	}

	@discardableResult
	public func hangup(
		voiceSessionID: String, reason: VoiceCallEndReason, inputAudioSeconds: Int,
		outputAudioSeconds: Int
	) async throws -> String? {
		struct Body: Encodable {
			let reason: String
			let input_audio_seconds: Int
			let output_audio_seconds: Int
		}
		let data = try await post(
			"voice-sessions/\(voiceSessionID)/hangup",
			body: Body(
				reason: reason.rawValue, input_audio_seconds: max(0, inputAudioSeconds),
				output_audio_seconds: max(0, outputAudioSeconds)))
		struct Ended: Decodable { let conversation_id: String? }
		return try decode(Ended.self, from: data).conversation_id
	}

	// MARK: Transport

	func makeRequest(path: String, body: some Encodable, credentials: MaskinCredentials?) throws -> URLRequest {
		var request = URLRequest(url: baseURL.appendingPathComponent("api").appendingPathComponent(path))
		request.httpMethod = "POST"
		request.timeoutInterval = 30
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		if let credentials {
			request.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
			if let workspaceId = credentials.workspaceId {
				request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id")
			}
		}
		request.httpBody = try JSONEncoder().encode(body)
		return request
	}

	private func post(_ path: String, body: some Encodable) async throws -> Data {
		let request = try makeRequest(path: path, body: body, credentials: await credentials())
		let data: Data
		let response: URLResponse
		do {
			(data, response) = try await session.data(for: request)
		} catch {
			throw VoiceCallFailure.network("Couldn't reach Maskin. Check your connection and try again.")
		}
		guard let http = response as? HTTPURLResponse else {
			throw VoiceCallFailure.server("Unexpected response from Maskin.")
		}
		if (200..<300).contains(http.statusCode) { return data }
		throw Self.failure(status: http.statusCode, body: data)
	}

	private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
		do {
			return try JSONDecoder().decode(type, from: data)
		} catch {
			throw VoiceCallFailure.server("Unexpected response from Maskin.")
		}
	}

	/// The error a non-2xx answer means.
	static func failure(status: Int, body: Data) -> VoiceCallFailure {
		struct Envelope: Decodable {
			struct Err: Decodable { let message: String? }
			let error: Err?
			let retry_after_seconds: Double?
		}
		let envelope = try? JSONDecoder().decode(Envelope.self, from: body)
		switch status {
		case 404: return .unavailable
		case 400: return .notAnAgent
		case 409: return .alreadyInCall
		case 429: return .rateLimited(retryAfterSeconds: envelope?.retry_after_seconds.map { Int($0) })
		default:
			return .server(envelope?.error?.message ?? "Voice call failed (\(status)).")
		}
	}
}
