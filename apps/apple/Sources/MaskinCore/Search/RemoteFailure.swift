import Foundation
import OpenAPIRuntime

/// Maps whatever a generated-client call threw onto the small error types Search and Files show.
enum RemoteFailure {
	static func describe(_ error: Error) -> (message: String, isOffline: Bool) {
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

	static func searchError(_ error: Error) -> SearchError {
		let d = describe(error)
		return SearchError(d.message, isOffline: d.isOffline)
	}
}
