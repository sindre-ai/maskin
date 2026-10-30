import Foundation
import MaskinAPI
import OpenAPIRuntime

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
	/// 404: the agent is not in the workspace. The caller falls back to the dictation-based call.
	case unavailable
	/// 400: the target is not an agent.
	case notAnAgent
	/// 409: this person already has a live call (or the session already took its offer).
	case alreadyInCall
	/// 429: the vendor is rate limiting calls.
	case rateLimited(retryAfterSeconds: Int?)
	case server(String)
	case network(String)

	/// What to show on the call screen.
	public var message: String {
		switch self {
		case .unavailable: return "Voice calls aren't available right now."
		case .notAnAgent: return "That isn't an agent, so it can't take a call."
		case .alreadyInCall: return "You're already in a call. End it and try again."
		case .rateLimited: return "Voice is busy right now. Try again in a moment."
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
	/// `conversationID` is the chat the call was started from, so the agent knows what was said
	/// there; nil for a call that isn't tied to a chat.
	func create(agentActorID: String, conversationID: String?) async throws -> String
	func offer(voiceSessionID: String, sdp: String) async throws -> VoiceCallAnswer
	/// Ends the call. Idempotent on the server. Returns the id of the conversation the transcript
	/// was saved to, if any.
	@discardableResult
	func hangup(
		voiceSessionID: String, reason: VoiceCallEndReason, inputAudioSeconds: Int,
		outputAudioSeconds: Int
	) async throws -> String?
}

/// `/api/voice-sessions` on the generated client. The generated operation names stop here; the
/// rest of the app sees `VoiceCalling`.
public struct URLSessionVoiceCalls: VoiceCalling {
	private let client: Client

	public init(
		baseURL: URL, clientSource: String, credentials: @escaping MaskinCredentialsProvider,
		session: URLSession? = nil
	) {
		self.client = MaskinClient.make(
			serverURL: baseURL, clientSource: clientSource, credentials: credentials, session: session)
	}

	init(client: Client) {
		self.client = client
	}

	public func create(agentActorID: String, conversationID: String?) async throws -> String {
		let output = try await send {
			try await client.post_sol_api_sol_voice_hyphen_sessions(
				body: .json(.init(agent_actor_id: agentActorID, conversation_id: conversationID)))
		}
		switch output {
		case .created(let created): return try decoded { try created.body.json.voice_session_id }
		case .badRequest: throw Self.failure(status: 400)
		case .notFound: throw Self.failure(status: 404)
		case .conflict: throw Self.failure(status: 409)
		case .internalServerError(let failed):
			throw Self.failure(status: 500, message: try? failed.body.json.error.message)
		case .undocumented(let status, _): throw Self.failure(status: status)
		}
	}

	public func offer(voiceSessionID: String, sdp: String) async throws -> VoiceCallAnswer {
		let output = try await send {
			try await client.post_sol_api_sol_voice_hyphen_sessions_sol__lcub_id_rcub__sol_offer(
				path: .init(id: voiceSessionID), body: .json(.init(sdp: sdp)))
		}
		switch output {
		case .ok(let ok):
			let answer = try decoded { try ok.body.json }
			return VoiceCallAnswer(
				sdp: answer.sdp, toolsAvailable: answer.tools_available,
				persistTranscripts: answer.persist_transcripts)
		case .notFound: throw Self.failure(status: 404)
		case .conflict: throw Self.failure(status: 409)
		case .tooManyRequests(let limited):
			throw Self.failure(
				status: 429, retryAfterSeconds: try? limited.body.json.retry_after_seconds)
		case .internalServerError(let failed):
			throw Self.failure(status: 500, message: try? failed.body.json.error.message)
		case .undocumented(let status, _): throw Self.failure(status: status)
		}
	}

	@discardableResult
	public func hangup(
		voiceSessionID: String, reason: VoiceCallEndReason, inputAudioSeconds: Int,
		outputAudioSeconds: Int
	) async throws -> String? {
		let body = Components.Schemas.HangupVoiceSessionBody(
			reason: reason == .userHangup ? .user_hangup : .network_error,
			input_audio_seconds: max(0, inputAudioSeconds),
			output_audio_seconds: max(0, outputAudioSeconds))
		let output = try await send {
			try await client.post_sol_api_sol_voice_hyphen_sessions_sol__lcub_id_rcub__sol_hangup(
				path: .init(id: voiceSessionID), body: .json(body))
		}
		switch output {
		case .ok(let ok): return try decoded { try ok.body.json.conversation_id }
		case .notFound: throw Self.failure(status: 404)
		case .undocumented(let status, _): throw Self.failure(status: status)
		}
	}

	// MARK: Transport

	/// Runs one generated call. Anything that stops it before a status code comes back is a
	/// connection problem when `URLSession` was the cause, and an unreadable answer otherwise.
	private func send<Output>(_ call: () async throws -> Output) async throws -> Output {
		do {
			return try await call()
		} catch {
			var current: Error? = error
			while let e = current {
				if e is URLError {
					throw VoiceCallFailure.network("Couldn't reach Maskin. Check your connection and try again.")
				}
				current = (e as? ClientError)?.underlyingError
			}
			throw VoiceCallFailure.server("Unexpected response from Maskin.")
		}
	}

	/// Reading a documented body can still throw when the server sent a different content type.
	private func decoded<T>(_ read: () throws -> T) throws -> T {
		do { return try read() } catch { throw VoiceCallFailure.server("Unexpected response from Maskin.") }
	}

	/// The error a non-2xx answer means. `message` is the server's own text, used for 5xx.
	static func failure(
		status: Int, message: String? = nil, retryAfterSeconds: Double? = nil
	) -> VoiceCallFailure {
		switch status {
		case 404: return .unavailable
		case 400: return .notAnAgent
		case 409: return .alreadyInCall
		case 429: return .rateLimited(retryAfterSeconds: retryAfterSeconds.map { Int($0) })
		default: return .server(message ?? "Voice call failed (\(status)).")
		}
	}
}
