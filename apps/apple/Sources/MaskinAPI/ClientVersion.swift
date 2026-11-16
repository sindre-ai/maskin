import Foundation

/// The app's release number, sent as `X-Client-Version` so the API can count requests per release.
///
/// It is `CFBundleShortVersionString` (such as `1.2`). The API only accepts digits and dots, 1 to
/// 12 characters, so anything else is not sent at all rather than sent and discarded.
public enum ClientVersion {
	public static let headerName = "X-Client-Version"

	/// This process's release, read once. `nil` when the bundle has no usable version (tests).
	public static let current: String? = value(
		from: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)

	/// `shortVersion` if it is 1 to 12 ASCII digits and dots, else `nil`.
	static func value(from shortVersion: String?) -> String? {
		guard let shortVersion, (1...12).contains(shortVersion.utf8.count),
			shortVersion.utf8.allSatisfy({ (48...57).contains($0) || $0 == 46 })
		else { return nil }
		return shortVersion
	}
}
