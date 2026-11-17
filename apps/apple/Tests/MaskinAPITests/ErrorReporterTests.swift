import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import MaskinAPI

private final class RecordingSink: ErrorReportSink, @unchecked Sendable {
	private let lock = NSLock()
	private var _reports: [ErrorReport] = []
	private var _workspaces: [String?] = []
	var reports: [ErrorReport] { lock.withLock { _reports } }
	var workspaces: [String?] { lock.withLock { _workspaces } }
	func send(_ report: ErrorReport) { lock.withLock { _reports.append(report) } }
	func workspaceChanged(_ workspaceId: String?) { lock.withLock { _workspaces.append(workspaceId) } }
}

private final class Clock: @unchecked Sendable {
	private let lock = NSLock()
	private var at = Date(timeIntervalSince1970: 1_800_000_000)
	func now() -> Date { lock.withLock { at } }
	func advance(_ seconds: TimeInterval) { lock.withLock { at = at.addingTimeInterval(seconds) } }
}

private func make() -> (ErrorReporter, RecordingSink, Clock) {
	let clock = Clock()
	let sink = RecordingSink()
	let reporter = ErrorReporter(now: { clock.now() })
	reporter.configure(sink: sink)
	return (reporter, sink, clock)
}

private func clientError(_ underlying: any Error, operation: String = "get_sol_api_sol_objects") -> ClientError {
	ClientError(
		operationID: operation, operationInput: (), causeDescription: "Response deserialization failed",
		underlyingError: underlying)
}

@Suite("Error reporter")
struct ErrorReporterTests {
	@Test("a 5xx is reported once per hour per operation, then again after the hour")
	func dedupesServerErrors() {
		let (reporter, sink, clock) = make()
		reporter.reportResponse(status: 500, operationID: "a")
		reporter.reportResponse(status: 502, operationID: "a")
		reporter.reportResponse(status: 500, operationID: "b")
		#expect(sink.reports.map(\.operationID) == ["a", "b"])
		clock.advance(ErrorReporter.window - 1)
		reporter.reportResponse(status: 500, operationID: "a")
		#expect(sink.reports.count == 2)
		clock.advance(2)
		reporter.reportResponse(status: 500, operationID: "a")
		#expect(sink.reports.count == 3)
	}

	@Test("a client error (4xx) and a success are not reported")
	func ignoresNon5xx() {
		let (reporter, sink, _) = make()
		for status in [200, 204, 301, 401, 404, 409, 422, 429] {
			reporter.reportResponse(status: status, operationID: "a")
		}
		#expect(sink.reports.isEmpty)
	}

	@Test("no network and a cancelled request are not reported")
	func ignoresOfflineAndCancelled() {
		let (reporter, sink, _) = make()
		let quiet: [URLError.Code] = [
			.cancelled, .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
			.cannotFindHost, .timedOut, .dataNotAllowed,
		]
		for code in quiet { reporter.reportTransport(URLError(code), operationID: "a") }
		#expect(sink.reports.isEmpty)
		reporter.reportTransport(URLError(.secureConnectionFailed), operationID: "a")
		#expect(sink.reports.map(\.kind) == [.transport])
	}

	@Test("a reply that cannot be read is reported as decoding, once per operation per hour")
	func decoding() {
		let (reporter, sink, _) = make()
		let failure = clientError(DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "secret text")))
		reporter.reportThrown(failure)
		reporter.reportThrown(failure)
		reporter.reportThrown(DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "x")))
		#expect(sink.reports.map(\.kind) == [.decoding, .decoding])
		#expect(sink.reports.map(\.operationID) == ["get_sol_api_sol_objects", "unknown"])
	}

	@Test("network failures and cancellation seen by a store are not decoding errors")
	func thrownNetworkIsNotDecoding() {
		let (reporter, sink, _) = make()
		reporter.reportThrown(clientError(URLError(.notConnectedToInternet)))
		reporter.reportThrown(clientError(URLError(.secureConnectionFailed)))
		reporter.reportThrown(clientError(CancellationError()))
		reporter.reportThrown(CancellationError())
		reporter.reportThrown(URLError(.cancelled))
		#expect(sink.reports.isEmpty)
	}

	@Test("the same failure in another workspace is its own report")
	func perWorkspace() {
		let (reporter, sink, _) = make()
		reporter.setWorkspace("ws-1")
		reporter.reportResponse(status: 500, operationID: "a")
		reporter.setWorkspace("ws-2")
		reporter.reportResponse(status: 500, operationID: "a")
		#expect(sink.reports.map(\.workspaceId) == ["ws-1", "ws-2"])
		#expect(sink.workspaces == [nil, "ws-1", "ws-2"])
	}

	@Test("without a sink nothing happens")
	func inertWithoutSink() {
		let reporter = ErrorReporter()
		reporter.reportResponse(status: 500, operationID: "a")
		reporter.reportThrown(clientError(DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: ""))))
		reporter.setWorkspace("ws-1")
	}

	@Test("a report carries only the allowed tags, never a message, URL or body")
	func tagsAreTheAllowList() {
		let report = ErrorReport(kind: .server, operationID: "a", statusCode: 503, workspaceId: "ws-1")
		#expect(report.tags == ["kind": "server", "operation": "a", "status": "503", "workspace_id": "ws-1"])
		#expect(Set(report.tags.keys).isSubset(of: ErrorReportTags.allowed))
		let bare = ErrorReport(kind: .decoding, operationID: "a")
		#expect(bare.tags == ["kind": "decoding", "operation": "a"])
	}

	@Test("scrubbing drops every tag outside the allow list")
	func scrubDropsOtherTags() {
		let scrubbed = ErrorReportTags.scrub([
			"kind": "server", "workspace_id": "ws-1", "app_version": "1.2", "build": "2611171200",
			"user": "alex@example.com", "url": "https://maskin.io/api/objects", "message": "hello",
			"device.name": "Alex's iPhone",
		])
		#expect(Set(scrubbed.keys) == ["kind", "workspace_id", "app_version", "build"])
	}
}

@Suite("Error reporting middleware")
struct ErrorReportingMiddlewareTests {
	private func run(
		_ reporter: ErrorReporter, result: @escaping @Sendable () throws -> HTTPResponse
	) async throws {
		let middleware = ErrorReportingMiddleware(reporter: reporter)
		_ = try await middleware.intercept(
			HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/x"), body: nil,
			baseURL: URL(string: "http://localhost")!, operationID: "get_x"
		) { _, _, _ in (try result(), nil) }
	}

	@Test("a 500 answer is reported and still returned")
	func serverError() async throws {
		let (reporter, sink, _) = make()
		try await run(reporter) { HTTPResponse(status: .internalServerError) }
		#expect(sink.reports == [ErrorReport(kind: .server, operationID: "get_x", statusCode: 500)])
	}

	@Test("a 404 answer is not reported")
	func notFound() async throws {
		let (reporter, sink, _) = make()
		try await run(reporter) { HTTPResponse(status: .notFound) }
		#expect(sink.reports.isEmpty)
	}

	@Test("a thrown network error is reported once and rethrown, unless it is offline")
	func transportError() async {
		let (reporter, sink, _) = make()
		await #expect(throws: URLError.self) {
			try await run(reporter) { throw URLError(.secureConnectionFailed) }
		}
		await #expect(throws: URLError.self) {
			try await run(reporter) { throw URLError(.notConnectedToInternet) }
		}
		#expect(sink.reports.map(\.kind) == [.transport])
	}
}
