import Foundation
import Observation

/// One pending device sign-in: the code the person types at maskin.io/tv and the private code
/// the device polls with. `deviceCode` never reaches the screen.
public struct DeviceCode: Sendable, Equatable {
	public var deviceCode: String
	public var userCode: String
	/// Where to send the person, plain (`maskin.io/tv`) and with the code filled in (for a QR).
	public var verificationURI: URL
	public var verificationURIComplete: URL
	public var expiresAt: Date
	public var interval: TimeInterval

	public init(
		deviceCode: String, userCode: String, verificationURI: URL, verificationURIComplete: URL,
		expiresAt: Date, interval: TimeInterval
	) {
		self.deviceCode = deviceCode
		self.userCode = userCode
		self.verificationURI = verificationURI
		self.verificationURIComplete = verificationURIComplete
		self.expiresAt = expiresAt
		self.interval = interval
	}

	/// "maskin.io/tv": the address as a person says it, without scheme.
	public var displayAddress: String {
		let host = verificationURI.host ?? verificationURI.absoluteString
		let path = verificationURI.path
		return path.isEmpty || path == "/" ? host : host + path
	}
}

public enum DevicePollResult: Sendable, Equatable {
	case pending(interval: TimeInterval?)
	case approved(LoginResult)
	case denied
	case expired
}

public enum DeviceSignInError: Error, Sendable, Equatable {
	case network
	case rateLimited
	case server(status: Int)
	case unreadable
}

/// The two public routes of the device sign-in. A protocol so the model tests without a server.
public protocol DeviceAuthorizing: Sendable {
	func start(deviceName: String) async throws -> DeviceCode
	func poll(deviceCode: String) async throws -> DevicePollResult
}

/// Production `DeviceAuthorizing`: `POST /api/device-auth/start` and `/token`. Hand-written over
/// URLSession because the checked-in generated client predates these routes; move it onto the
/// generated client the next time `scripts/gen-api.sh` runs.
public struct APIDeviceAuthorizer: DeviceAuthorizing {
	private let serverURL: URL
	private let clientSource: String
	private let session: URLSession
	private let now: @Sendable () -> Date

	public init(
		serverURL: URL, clientSource: String, session: URLSession = .shared,
		now: @escaping @Sendable () -> Date = { Date() }
	) {
		self.serverURL = serverURL
		self.clientSource = clientSource
		self.session = session
		self.now = now
	}

	public func start(deviceName: String) async throws -> DeviceCode {
		let (data, status) = try await post(
			"api/device-auth/start", body: ["client": clientSource, "device_name": deviceName])
		guard status == 201 || status == 200 else { throw Self.failure(status) }
		guard let reply = try? JSONDecoder().decode(StartReply.self, from: data),
			let uri = URL(string: reply.verification_uri),
			let complete = URL(string: reply.verification_uri_complete)
		else { throw DeviceSignInError.unreadable }
		return DeviceCode(
			deviceCode: reply.device_code, userCode: reply.user_code, verificationURI: uri,
			verificationURIComplete: complete, expiresAt: now().addingTimeInterval(TimeInterval(reply.expires_in)),
			interval: TimeInterval(max(1, reply.interval)))
	}

	public func poll(deviceCode: String) async throws -> DevicePollResult {
		let (data, status) = try await post("api/device-auth/token", body: ["device_code": deviceCode])
		guard status == 200 else { throw Self.failure(status) }
		guard let reply = try? JSONDecoder().decode(TokenReply.self, from: data)
		else { throw DeviceSignInError.unreadable }
		switch reply.status {
		case "approved":
			guard let actor = reply.actor, let key = actor.api_key else { throw DeviceSignInError.unreadable }
			return .approved(
				LoginResult(
					apiKey: key, actorId: actor.id, name: actor.name, email: actor.email,
					workspaceId: actor.workspace_id))
		case "denied": return .denied
		case "expired": return .expired
		default: return .pending(interval: reply.interval.map { TimeInterval(max(1, $0)) })
		}
	}

	private static func failure(_ status: Int) -> DeviceSignInError {
		status == 429 ? .rateLimited : .server(status: status)
	}

	private func post(_ path: String, body: [String: String]) async throws -> (Data, Int) {
		var request = URLRequest(url: serverURL.appending(path: path))
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		request.httpBody = try JSONSerialization.data(withJSONObject: body)
		do {
			let (data, response) = try await session.data(for: request)
			return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
		} catch is CancellationError {
			throw CancellationError()
		} catch {
			throw DeviceSignInError.network
		}
	}

	private struct StartReply: Decodable {
		var device_code: String
		var user_code: String
		var verification_uri: String
		var verification_uri_complete: String
		var expires_in: Int
		var interval: Int
	}

	private struct TokenReply: Decodable {
		struct Actor: Decodable {
			var id: String
			var name: String
			var email: String?
			var api_key: String?
			var workspace_id: String?
		}
		var status: String
		var interval: Int?
		var actor: Actor?
	}
}

/// Drives the code screen: asks for a code, polls until the person approves it on their phone or
/// computer, hands the session to `AuthSession`, and starts over when the code runs out.
@MainActor
@Observable
public final class DeviceSignInModel {
	public enum Phase: Equatable, Sendable {
		case starting
		case waiting(DeviceCode)
		case denied
		case expired
		/// Could not reach Maskin (or the server refused); the screen offers Try again.
		case failed(String)
	}

	public private(set) var phase: Phase = .starting

	@ObservationIgnored private let authorizer: any DeviceAuthorizing
	@ObservationIgnored private let auth: AuthSession
	@ObservationIgnored private let deviceName: String
	@ObservationIgnored private let sleep: @Sendable (TimeInterval) async throws -> Void
	@ObservationIgnored private let now: @Sendable () -> Date
	@ObservationIgnored private var task: Task<Void, Never>?

	public init(
		authorizer: any DeviceAuthorizing, auth: AuthSession, deviceName: String,
		sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) },
		now: @escaping @Sendable () -> Date = { Date() }
	) {
		self.authorizer = authorizer
		self.auth = auth
		self.deviceName = String(deviceName.prefix(60))
		self.sleep = sleep
		self.now = now
	}

	/// Ask for a fresh code and poll it. Safe to call again (Try again, a new code).
	public func begin() {
		task?.cancel()
		phase = .starting
		task = Task { await run() }
	}

	public func stop() {
		task?.cancel()
		task = nil
	}

	/// Awaitable form of `begin()` for tests.
	func run() async {
		let code: DeviceCode
		do {
			code = try await authorizer.start(deviceName: deviceName)
		} catch is CancellationError {
			return
		} catch {
			phase = .failed(Self.message(for: error))
			return
		}
		phase = .waiting(code)
		var interval = code.interval
		while !Task.isCancelled {
			do { try await sleep(interval) } catch { return }
			if now() >= code.expiresAt {
				phase = .expired
				return
			}
			do {
				switch try await authorizer.poll(deviceCode: code.deviceCode) {
				case .pending(let next):
					if let next { interval = next }
				case .approved(let login):
					let stored = StoredSession(
						apiKey: login.apiKey, actorId: login.actorId, name: login.name,
						email: login.email, workspaceId: login.workspaceId)
					do {
						try auth.adopt(stored)
					} catch {
						phase = .failed("Signed in, but this Apple TV couldn\u{2019}t save the session.")
					}
					return
				case .denied:
					phase = .denied
					return
				case .expired:
					phase = .expired
					return
				}
			} catch is CancellationError {
				return
			} catch DeviceSignInError.rateLimited {
				// Polling too fast: back off rather than fail a sign-in that may be approved.
				interval = min(interval * 2, 30)
			} catch {
				// A dropped connection mid-wait is not the end of the code; keep trying until it expires.
				continue
			}
		}
	}

	static func message(for error: any Error) -> String {
		switch error as? DeviceSignInError {
		case .network?: "Can\u{2019}t reach Maskin."
		case .rateLimited?: "Too many tries. Wait a minute, then try again."
		case .server(let status)?: "Maskin is having trouble (error \(status))."
		default: "Maskin answered, but this Apple TV couldn\u{2019}t read the reply."
		}
	}
}
