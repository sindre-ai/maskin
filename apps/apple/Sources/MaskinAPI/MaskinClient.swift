import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession

/// What every authenticated request carries. The key is the `ank_…` API key returned by
/// `POST /api/auth/login`; the workspace scopes every workspace-level route (the backend's
/// `authMiddleware` checks membership from this header, so callers don't re-check it).
public struct MaskinCredentials: Sendable, Equatable {
	public var apiKey: String
	public var workspaceId: String?

	public init(apiKey: String, workspaceId: String? = nil) {
		self.apiKey = apiKey
		self.workspaceId = workspaceId
	}
}

/// Source of truth for credentials at request time, so a workspace switch or sign-out takes
/// effect on the very next call without rebuilding the client.
public typealias MaskinCredentialsProvider = @Sendable () async -> MaskinCredentials?

/// Adds `Authorization`, `X-Workspace-Id`, `X-Client-Source`, `X-Client-Build` and `X-Client-Version` to every request.
struct MaskinAuthMiddleware: ClientMiddleware {
	let credentials: MaskinCredentialsProvider
	let clientSource: String
	/// Called with the API key that was sent when the server answers 401, so the app can end a
	/// revoked or rotated session in one place instead of every store noticing separately.
	var onUnauthorized: (@Sendable (_ apiKey: String) async -> Void)?
	/// The app build, so the API can count requests per build. `nil` sends no header.
	var clientBuild: String? = ClientBuild.current
	/// The app release, so the API can count requests per release. `nil` sends no header.
	var clientVersion: String? = ClientVersion.current

	func intercept(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String,
		next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
	) async throws -> (HTTPResponse, HTTPBody?) {
		var request = request
		request.headerFields[.xClientSource] = clientSource
		if let clientBuild { request.headerFields[.xClientBuild] = clientBuild }
		if let clientVersion { request.headerFields[.xClientVersion] = clientVersion }
		var sentKey: String?
		if let creds = await credentials() {
			sentKey = creds.apiKey
			request.headerFields[.authorization] = "Bearer \(creds.apiKey)"
			if let workspaceId = creds.workspaceId {
				request.headerFields[.xWorkspaceId] = workspaceId
			}
		}
		let result = try await next(request, body, baseURL)
		// Only a request that carried a key can mean "that key is bad" (login's own 401 is not).
		if result.0.status.code == 401, let sentKey { await onUnauthorized?(sentKey) }
		return result
	}
}

extension HTTPField.Name {
	static let xClientSource = HTTPField.Name("X-Client-Source")!
	static let xClientBuild = HTTPField.Name(ClientBuild.headerName)!
	static let xClientVersion = HTTPField.Name(ClientVersion.headerName)!
	static let xWorkspaceId = HTTPField.Name("X-Workspace-Id")!
}

public enum MaskinClient {
	/// Build the generated client. `clientSource` is the `X-Client-Source` value (`ios`,
	/// `macos`, `watchos`, `tvos`) so server-side analytics can tell the surfaces apart.
	public static func make(
		serverURL: URL,
		clientSource: String,
		credentials: @escaping MaskinCredentialsProvider,
		onUnauthorized: (@Sendable (_ apiKey: String) async -> Void)? = nil,
		session: URLSession? = nil,
		errorReporter: ErrorReporter = .shared
	) -> Client {
		Client(
			serverURL: serverURL,
			transport: session.map { URLSessionTransport(configuration: .init(session: $0)) }
				?? URLSessionTransport(),
			middlewares: [
				ErrorReportingMiddleware(reporter: errorReporter),
				MaskinAuthMiddleware(
					credentials: credentials, clientSource: clientSource, onUnauthorized: onUnauthorized),
				IdempotencyMiddleware(),
			]
		)
	}
}

// MARK: - Error reporting

/// One report about a failed call to our own server. It is built from a fixed vocabulary on
/// purpose: a kind, the operation's name from the OpenAPI spec, a status code and the workspace id.
/// There is no field for message text, a URL, a header or a body, so none can be sent.
public struct ErrorReport: Sendable, Equatable {
	public enum Kind: String, Sendable {
		/// The server answered with a 5xx.
		case server
		/// The request never got an answer (TLS failure, bad reply). Offline and cancelled are not reported.
		case transport
		/// The server answered but the reply could not be read.
		case decoding
	}

	public var kind: Kind
	public var operationID: String
	public var statusCode: Int?
	public var workspaceId: String?

	public init(kind: Kind, operationID: String, statusCode: Int? = nil, workspaceId: String? = nil) {
		self.kind = kind
		self.operationID = operationID
		self.statusCode = statusCode
		self.workspaceId = workspaceId
	}

	/// The tags the report carries, and the only ones: see `ErrorReportTags.allowed`.
	public var tags: [String: String] {
		var tags = ["kind": kind.rawValue, "operation": operationID]
		if let statusCode { tags["status"] = String(statusCode) }
		if let workspaceId { tags["workspace_id"] = workspaceId }
		return tags
	}
}

public enum ErrorReportTags {
	/// Every tag an error report may carry. `app_version` and `build` are added once at start-up by
	/// the Sentry sink. The sink drops any other tag before an event leaves the phone.
	public static let allowed: Set<String> = ["kind", "operation", "status", "workspace_id", "app_version", "build"]

	public static func scrub(_ tags: [String: String]) -> [String: String] {
		var kept: [String: String] = [:]
		for (key, value) in tags where allowed.contains(key) { kept[key] = value }
		return kept
	}
}

/// The rest of what an event may carry, for crashes, hangs and watchdog kills as well as reports.
/// Kept here, away from the Sentry types, so `swift test` can check the rules.
public enum ErrorReportScrub {
	/// The only context blocks that stay: the app, the device and the OS description.
	public static let contextKeys: Set<String> = ["app", "device", "os"]

	public static func contexts<Value>(_ contexts: [String: Value]) -> [String: Value] {
		var kept: [String: Value] = [:]
		for (key, value) in contexts where contextKeys.contains(key) { kept[key] = value }
		return kept
	}

	/// An exception's text can hold whatever the code was working on, so only its type is kept.
	public static func exceptionText(type: String?) -> String { type ?? "" }
}

/// Where reports go. The real one is `SentrySink` in MaskinFeatures; tests record calls.
public protocol ErrorReportSink: Sendable {
	func send(_ report: ErrorReport)
	/// The signed-in workspace changed (nil = signed out). Crash reports carry it too.
	func workspaceChanged(_ workspaceId: String?)
}

/// Decides what is worth reporting from a failed call, and sends each kind of failure at most once
/// per hour (the same idea as `apps/dev/src/lib/sentry-dedupe.ts`: one noisy outage must not use up
/// the Sentry quota). A repeat is dropped until the window has passed since the last one sent.
///
/// Without a sink (debug builds, tests, extensions, builds with no Sentry address) every call is a
/// no-op. Not reported on purpose: a phone with no network, a cancelled request, any 4xx.
public final class ErrorReporter: @unchecked Sendable {
	public static let shared = ErrorReporter()
	public static let window: TimeInterval = 60 * 60
	/// Backstop against unbounded growth: keys are kind x operation x workspace.
	private static let pruneAbove = 500

	private let lock = NSLock()
	private let now: @Sendable () -> Date
	private var sink: (any ErrorReportSink)?
	private var workspaceId: String?
	private var lastSent: [String: Date] = [:]

	public init(now: @escaping @Sendable () -> Date = { Date() }) { self.now = now }

	// The lock is taken with lock() and unlock(), not with withLock { }: the Swift 6.3 compiler in Xcode 26.6
	// never finishes optimizing a closure like that one when it has several exits (it looped for over an
	// hour in the closure-lifetime pass), so nothing in this class passes a closure to the lock.

	public func configure(sink: (any ErrorReportSink)?) {
		lock.lock()
		self.sink = sink
		let current = workspaceId
		lock.unlock()
		sink?.workspaceChanged(current)
	}

	public func setWorkspace(_ workspaceId: String?) {
		lock.lock()
		self.workspaceId = workspaceId
		let sink = self.sink
		lock.unlock()
		sink?.workspaceChanged(workspaceId)
	}

	/// A response from our server. Only 5xx is reported: a 4xx is the server doing its job.
	public func reportResponse(status: Int, operationID: String) {
		guard status >= 500 else { return }
		submit(ErrorReport(kind: .server, operationID: operationID, statusCode: status))
	}

	/// A request that threw before any answer came back.
	public func reportTransport(_ error: URLError, operationID: String) {
		guard !Self.isQuiet(error) else { return }
		submit(ErrorReport(kind: .transport, operationID: operationID))
	}

	/// Whatever a call threw. Only a reply that could not be read is reported here (a generated
	/// client error whose cause is not the network, or a `DecodingError` from our own parsing).
	/// A network failure was already seen by the middleware, and anything not from the client
	/// is not ours to report.
	public func reportThrown(_ error: any Error) {
		if error is DecodingError { return submit(ErrorReport(kind: .decoding, operationID: "unknown")) }
		guard let client = error as? ClientError else { return }
		var underlying: any Error = client.underlyingError
		while let nested = (underlying as? ClientError)?.underlyingError { underlying = nested }
		if underlying is URLError || underlying is CancellationError { return }
		submit(ErrorReport(kind: .decoding, operationID: client.operationID))
	}

	/// No network, or the person (or the system) cancelled the request.
	static func isQuiet(_ error: URLError) -> Bool {
		switch error.code {
		case .cancelled, .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
			.cannotFindHost, .timedOut, .dataNotAllowed, .internationalRoamingOff, .callIsActive:
			true
		default: false
		}
	}

	private func submit(_ report: ErrorReport) {
		var report = report
		lock.lock()
		guard let sink else {
			lock.unlock()
			return
		}
		report.workspaceId = workspaceId
		let key = "\(report.kind.rawValue)\u{0}\(report.operationID)\u{0}\(report.workspaceId ?? "")"
		let at = now()
		var isRepeat = false
		if let previous = lastSent[key], at.timeIntervalSince(previous) < Self.window { isRepeat = true }
		if !isRepeat {
			if lastSent.count >= Self.pruneAbove { dropExpired(at: at) }
			lastSent[key] = at
		}
		lock.unlock()
		if !isRepeat { sink.send(report) }
	}

	/// Called with the lock held.
	private func dropExpired(at: Date) {
		var kept: [String: Date] = [:]
		for (key, sentAt) in lastSent where at.timeIntervalSince(sentAt) < Self.window { kept[key] = sentAt }
		lastSent = kept
	}
}

/// Reports failed calls to our own server: a 5xx answer, or a request that threw before any answer.
/// First in the chain, so it also sees what the other middlewares throw.
struct ErrorReportingMiddleware: ClientMiddleware {
	let reporter: ErrorReporter

	func intercept(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String,
		next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
	) async throws -> (HTTPResponse, HTTPBody?) {
		do {
			let result = try await next(request, body, baseURL)
			reporter.reportResponse(status: result.0.status.code, operationID: operationID)
			return result
		} catch {
			if let url = error as? URLError { reporter.reportTransport(url, operationID: operationID) }
			throw error
		}
	}
}
