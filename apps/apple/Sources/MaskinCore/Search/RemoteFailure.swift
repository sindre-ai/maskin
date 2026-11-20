import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Maps whatever a generated-client call threw onto the small error types Search and Files show.
enum RemoteFailure {
	static func describe(_ error: Error) -> (message: String, isOffline: Bool) {
		ErrorReporter.shared.reportThrown(error)
		var current: Error? = error
		while let e = current {
			if let url = e as? URLError {
				let offline: Set<URLError.Code> = [
					.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
					.cannotFindHost, .timedOut, .dataNotAllowed,
				]
				let isOffline = offline.contains(url.code)
				return (isOffline ? "You're offline." : "Couldn't reach the server.", isOffline)
			}
			current = (e as? ClientError)?.underlyingError
		}
		return ("Something went wrong. Try again.", false)
	}

	/// True when a call ended because it was cancelled (the screen refreshed, a newer load took
	/// over), however deep the generated client wrapped it: not a failure, nothing to show.
	static func isCancellation(_ error: Error) -> Bool {
		var current: Error? = error
		while let e = current {
			if e is CancellationError || (e as? URLError)?.code == .cancelled { return true }
			current = (e as? ClientError)?.underlyingError
		}
		return false
	}

	static func searchError(_ error: Error) -> SearchError {
		let d = describe(error)
		return SearchError(d.message, isOffline: d.isOffline)
	}
}
