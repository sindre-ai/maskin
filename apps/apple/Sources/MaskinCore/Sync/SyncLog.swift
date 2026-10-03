import CryptoKit
import Foundation
import os

/// Structured, privacy-safe logging for the sync layer (subsystem `io.maskin.app`).
///
/// Privacy stance: never log tokens, message text, names, emails or raw ids. Where a record needs
/// to be correlated, log `SyncLog.shortHash(_:)` (6 hex chars of SHA-256) instead. Counts,
/// durations and cache entry NAMES (fixed strings like `foryou.feed`) are fine.
public enum SyncLog {
	public static let subsystem = "io.maskin.app"
	public static let sync = Logger(subsystem: subsystem, category: "sync")
	public static let cache = Logger(subsystem: subsystem, category: "cache")
	public static let network = Logger(subsystem: subsystem, category: "network")

	/// A stable 6-hex-char fingerprint of an id, enough to correlate log lines, not to recover it.
	public static func shortHash(_ value: String?) -> String {
		guard let value else { return "-" }
		return String(hex(SHA256.hash(data: Data(value.utf8))).prefix(6))
	}

	static func hex(_ digest: SHA256.Digest) -> String {
		digest.map { String(format: "%02x", $0) }.joined()
	}

	/// Log a revalidation outcome with its duration. `outcome` is a fixed word, never an error
	/// description (those can carry server text).
	public static func revalidated(_ name: String, ok: Bool, since start: ContinuousClock.Instant) {
		let parts = start.duration(to: .now).components
		let ms = parts.seconds * 1000 + parts.attoseconds / 1_000_000_000_000_000
		if ok {
			network.info("revalidate ok name=\(name, privacy: .public) ms=\(ms)")
		} else {
			network.notice("revalidate failed name=\(name, privacy: .public) ms=\(ms)")
		}
	}
}
