import Foundation
import Observation

/// What the Caller ID settings row shows: the phone's on or off answer and how many numbers the
/// file holds. The numbers themselves never leave the file; only this count is kept.
@MainActor
@Observable
public final class CallerIDStatusStore {
	public private(set) var status: CallerIDStatus = .unknown
	/// Numbers in the file the extension reads (0 when there is no file).
	public private(set) var loadedCount = 0

	@ObservationIgnored private let directory: any CallDirectoryControlling
	@ObservationIgnored private let countLoaded: @Sendable () -> Int

	/// `countLoaded` says how many numbers the shared file holds right now.
	public init(directory: any CallDirectoryControlling, countLoaded: @escaping @Sendable () -> Int) {
		self.directory = directory
		self.countLoaded = countLoaded
	}

	/// Re-reads the phone's answer and the file's count.
	public func refreshStatus() async {
		status = await directory.status()
		loadedCount = countLoaded()
	}

	/// The file changed (a refresh wrote it, or sign out deleted it): ask the phone to load it
	/// again. A failure leaves the phone's earlier list in place, so it is not shown as an error.
	public func reloadPhone() async {
		try? await directory.reload()
		await refreshStatus()
	}

	/// The `caller_id_status` cross-check, once per app open. Re-reads first so the event says what
	/// the phone says now, not what it said at the last open.
	public func reportStatus(to analytics: Analytics) async {
		await refreshStatus()
		analytics.callerIDStatus(status, loadedCount: loadedCount)
	}
}

/// The count of loaded numbers as a bucket, so no list size is exact.
public enum CallerIDTracking {
	public static func numbersBucket(_ count: Int) -> String {
		switch count {
		case ...0: "0"
		case 1...100: "1_100"
		case 101...500: "101_500"
		case 501...999: "501_1000"
		default: "1000_plus"
		}
	}
}

extension Analytics {
	/// Whether Maskin is switched on for call identification, and how many numbers it holds as a
	/// bucket. Never a number or a name.
	public func callerIDStatus(_ status: CallerIDStatus, loadedCount: Int) {
		track(
			"caller_id_status",
			[
				"status": .string(status.rawValue),
				"numbers_bucket": .string(CallerIDTracking.numbersBucket(loadedCount)),
			])
	}
}
