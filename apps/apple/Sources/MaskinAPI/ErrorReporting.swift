import Foundation
import HTTPTypes
import OpenAPIRuntime

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
		tags.filter { allowed.contains($0.key) }
	}
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

	public func configure(sink: (any ErrorReportSink)?) {
		lock.withLock { self.sink = sink }
		sink?.workspaceChanged(lock.withLock { workspaceId })
	}

	public func setWorkspace(_ workspaceId: String?) {
		let sink = lock.withLock { () -> (any ErrorReportSink)? in
			self.workspaceId = workspaceId
			return self.sink
		}
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
		let (sink, send) = lock.withLock { () -> ((any ErrorReportSink)?, ErrorReport?) in
			guard let sink else { return (nil, nil) }
			var report = report
			report.workspaceId = workspaceId
			let key = "\(report.kind.rawValue)\u{0}\(report.operationID)\u{0}\(report.workspaceId ?? "")"
			let at = now()
			if let previous = lastSent[key], at.timeIntervalSince(previous) < Self.window { return (sink, nil) }
			if lastSent.count >= Self.pruneAbove {
				lastSent = lastSent.filter { at.timeIntervalSince($0.value) < Self.window }
			}
			lastSent[key] = at
			return (sink, report)
		}
		if let send { sink?.send(send) }
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
