import Foundation

/// The app's build number, sent as `X-Client-Build` so the API can count requests per app build.
///
/// It is `CFBundleVersion` (a timestamp such as `2611081015`). The API only accepts 1 to 12
/// digits, so anything else is not sent at all rather than sent and discarded.
public enum ClientBuild {
	public static let headerName = "X-Client-Build"

	/// This process's build, read once. `nil` when the bundle has no usable version (tests).
	public static let current: String? = value(
		from: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String)

	/// `bundleVersion` if it is 1 to 12 ASCII digits, else `nil`.
	static func value(from bundleVersion: String?) -> String? {
		guard let bundleVersion, (1...12).contains(bundleVersion.utf8.count),
			bundleVersion.utf8.allSatisfy({ (48...57).contains($0) })
		else { return nil }
		return bundleVersion
	}
}
