import Foundation
import MaskinCore
import Observation

// Device-code sign-in for Apple TV (RFC 8628 shape): the TV asks `POST /api/device-auth/start` for a
// code pair, shows the short code, and polls `POST /api/device-auth/token` while a signed-in person
// approves it at the verification page. The approval hands the TV the same session
// `POST /api/auth/login` returns, exactly once.

/// What the TV shows while the reader approves the sign-in on another device.
public struct TVDeviceCodePrompt: Equatable, Sendable {
	/// Shown as "BCDF-2345".
	public var userCode: String
	/// Where the reader types the code, as the server gives it ("https://maskin.io/tv").
	public var verificationURL: URL
	public var expiresAt: Date
	public var pollInterval: TimeInterval

	public init(userCode: String, verificationURL: URL, expiresAt: Date, pollInterval: TimeInterval = 5) {
		self.userCode = userCode
		self.verificationURL = verificationURL
		self.expiresAt = expiresAt
		self.pollInterval = pollInterval
	}

	/// "maskin.io/tv": the address without scheme, as people say it aloud.
	public var verificationLabel: String {
		let host = verificationURL.host ?? verificationURL.absoluteString
		let path = verificationURL.path == "/" ? "" : verificationURL.path
		return host + path
	}
}

public enum TVDeviceCodeOutcome: Equatable, Sendable {
	case pending
	case approved(LoginResult)
	case denied
	case expired
}

public protocol TVDeviceCodeSource: Sendable {
	func start() async throws -> TVDeviceCodePrompt
	func poll(userCode: String) async throws -> TVDeviceCodeOutcome
}

public struct TVDeviceCodeError: Error, Equatable, Sendable {
	public var message: String
	/// A blip worth retrying (no connection, a 5xx), as opposed to a refusal or a bad reply.
	public var isTransient: Bool
	public init(_ message: String, isTransient: Bool = false) {
		self.message = message
		self.isTransient = isTransient
	}
}

/// The live source. It keeps the secret `device_code` to itself: the screen only ever sees the
/// short user code.
public actor APITVDeviceCodeSource: TVDeviceCodeSource {
	public typealias Send = @Sendable (URLRequest) async throws -> (Data, Int)

	private let baseURL: URL
	private let deviceName: String?
	private let clientSource: String
	private let send: Send
	private let now: @Sendable () -> Date
	private var deviceCodes: [String: String] = [:]

	public init(
		baseURL: URL, deviceName: String? = nil, clientSource: String = "tvos",
		now: @escaping @Sendable () -> Date = Date.init, send: Send? = nil
	) {
		self.baseURL = baseURL
		self.deviceName = deviceName
		self.clientSource = clientSource
		self.now = now
		self.send =
			send ?? { request in
				let (data, response) = try await URLSession.shared.data(for: request)
				return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
			}
	}

	public func start() async throws -> TVDeviceCodePrompt {
		var body: [String: String] = ["client": "tvos"]
		if let name = deviceName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
			body["device_name"] = String(name.prefix(60))
		}
		let (data, status) = try await post("api/device-auth/start", body: body)
		guard status == 201 else { throw Self.error(status) }
		struct Wire: Decodable {
			var device_code: String
			var user_code: String
			var verification_uri: URL
			var expires_in: Int
			var interval: Int
		}
		guard let wire = try? JSONDecoder().decode(Wire.self, from: data) else {
			throw TVDeviceCodeError("Maskin answered, but the TV couldn't read the reply.")
		}
		let code = DeviceCode.normalize(wire.user_code).map(DeviceCode.format) ?? wire.user_code
		deviceCodes[code] = wire.device_code
		return TVDeviceCodePrompt(
			userCode: code, verificationURL: wire.verification_uri,
			expiresAt: now().addingTimeInterval(TimeInterval(wire.expires_in)),
			pollInterval: TimeInterval(max(1, wire.interval)))
	}

	public func poll(userCode: String) async throws -> TVDeviceCodeOutcome {
		guard let deviceCode = deviceCodes[userCode] else { return .expired }
		let (data, status) = try await post("api/device-auth/token", body: ["device_code": deviceCode])
		// Too many polls: wait and ask again, never a failure.
		if status == 429 { return .pending }
		guard status == 200 else { throw Self.error(status) }
		struct Wire: Decodable {
			struct Actor: Decodable {
				var id: String
				var name: String
				var email: String?
				var api_key: String
				var workspace_id: String?
			}
			var status: String
			var actor: Actor?
		}
		guard let wire = try? JSONDecoder().decode(Wire.self, from: data) else {
			throw TVDeviceCodeError("Maskin answered, but the TV couldn't read the reply.")
		}
		switch wire.status {
		case "approved":
			guard let actor = wire.actor, !actor.api_key.isEmpty else {
				throw TVDeviceCodeError("Maskin approved the sign-in but sent no session. Try again.")
			}
			deviceCodes[userCode] = nil
			return .approved(
				LoginResult(
					apiKey: actor.api_key, actorId: actor.id, name: actor.name, email: actor.email,
					workspaceId: actor.workspace_id))
		case "denied":
			deviceCodes[userCode] = nil
			return .denied
		case "expired":
			deviceCodes[userCode] = nil
			return .expired
		default:
			return .pending
		}
	}

	private func post(_ path: String, body: [String: String]) async throws -> (Data, Int) {
		var request = URLRequest(url: baseURL.appendingPathComponent(path))
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		request.httpBody = try JSONEncoder().encode(body)
		do {
			return try await send(request)
		} catch {
			throw TVDeviceCodeError("Can't reach Maskin. Check the connection and try again.", isTransient: true)
		}
	}

	static func error(_ status: Int) -> TVDeviceCodeError {
		status == 429
			? TVDeviceCodeError("Too many tries. Wait a minute and try again.")
			: TVDeviceCodeError(
				"Maskin is having trouble (error \(status)). Try again in a moment.", isTransient: status >= 500)
	}
}

/// Drives the sign-in code screen: asks for a code, polls until the reader approves, and asks for a
/// fresh code when one runs out. Stops polling when the screen goes away.
@MainActor
@Observable
public final class TVDeviceCodeStore {
	public enum Phase: Equatable, Sendable {
		case starting
		case showing(TVDeviceCodePrompt)
		/// The reader refused the code on their phone.
		case denied
		case failed(String)
	}

	public private(set) var phase: Phase = .starting

	@ObservationIgnored private let source: any TVDeviceCodeSource
	@ObservationIgnored private let onApproved: @MainActor (LoginResult) throws -> Void
	/// Failed polls in a row before the screen gives up (a Wi-Fi blip should not cost the code).
	public static let maxPollFailures = 5
	@ObservationIgnored private let now: () -> Date
	@ObservationIgnored private let sleep: @Sendable (TimeInterval) async -> Void
	@ObservationIgnored private var task: Task<Void, Never>?

	public init(
		source: any TVDeviceCodeSource, now: @escaping () -> Date = Date.init,
		sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) },
		onApproved: @escaping @MainActor (LoginResult) throws -> Void
	) {
		self.source = source
		self.now = now
		self.sleep = sleep
		self.onApproved = onApproved
	}

	/// Starts (or restarts) the sign-in. Safe to call again for "Try again".
	public func start() {
		task?.cancel()
		task = Task { [weak self] in await self?.run() }
	}

	public func stop() {
		task?.cancel()
		task = nil
	}

	/// Awaitable for tests: runs until approved, denied, failed or cancelled.
	func run() async {
		phase = .starting
		do {
			while !Task.isCancelled {
				let prompt = try await source.start()
				phase = .showing(prompt)
				switch try await wait(for: prompt) {
				case .approved(let login):
					do {
						try onApproved(login)
					} catch {
						// The server approved, but this TV could not keep the session.
						phase = .failed("Approved, but the TV couldn't save the sign-in. Try again.")
					}
					return
				case .denied:
					phase = .denied
					return
				case .expired, .pending:
					continue  // a fresh code, quietly
				}
			}
		} catch let error as TVDeviceCodeError {
			if !Task.isCancelled { phase = .failed(error.message) }
		} catch {
			if !Task.isCancelled { phase = .failed("Can't reach Maskin. Check the connection and try again.") }
		}
	}

	private func wait(for prompt: TVDeviceCodePrompt) async throws -> TVDeviceCodeOutcome {
		var failures = 0
		while !Task.isCancelled, now() < prompt.expiresAt {
			await sleep(prompt.pollInterval)
			if Task.isCancelled { break }
			let outcome: TVDeviceCodeOutcome
			do {
				outcome = try await source.poll(userCode: prompt.userCode)
				failures = 0
			} catch let error as TVDeviceCodeError where error.isTransient {
				failures += 1
				if failures >= Self.maxPollFailures { throw error }
				continue
			}
			if outcome != .pending { return outcome }
		}
		return .expired
	}
}
