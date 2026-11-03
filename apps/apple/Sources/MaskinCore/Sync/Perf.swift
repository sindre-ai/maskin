import Foundation
import os

/// Signpost intervals for the paths a reader waits on (subsystem `io.maskin.app`, category `perf`).
///
/// Open Instruments > os_signpost (or the Points of Interest track) to see each interval with its
/// duration. Names are fixed strings; never put message text, titles or ids in them.
public enum Perf {
	public static let signposter = OSSignposter(subsystem: SyncLog.subsystem, category: "perf")

	/// Run `body` inside a named signpost interval.
	public static func measure<T>(
		_ name: StaticString, isolation: isolated (any Actor)? = #isolation, _ body: () async -> T
	) async -> T {
		let id = signposter.makeSignpostID()
		let state = signposter.beginInterval(name, id: id)
		defer { signposter.endInterval(name, state) }
		return await body()
	}

	/// A single point in time, such as "first content on screen".
	public static func event(_ name: StaticString) {
		signposter.emitEvent(name)
	}
}
