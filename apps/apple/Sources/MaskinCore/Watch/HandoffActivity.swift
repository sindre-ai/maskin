import Foundation

/// The "Open on iPhone" Handoff from the watch: the card the wearer is looking at, carried to the
/// phone as an `NSUserActivity` so a swipe up from the app switcher lands on the same thing.
public enum HandoffActivity {
	/// Declared under `NSUserActivityTypes` in both the watch and the iPhone app.
	public static let type = "io.maskin.app.open-object"
	private static let urlKey = "url"

	/// The activity's payload for the object a card is about. Property-list types only.
	public static func userInfo(workspaceId: String, objectId: String) -> [String: Any] {
		[urlKey: DeepLink.object(workspaceId: workspaceId, id: objectId).url.absoluteString]
	}

	/// The Maskin link inside a received activity, or nil for anything that isn't one of ours. The
	/// router validates the link itself (membership, malformed ids); this only unwraps it.
	public static func link(from userInfo: [AnyHashable: Any]?) -> URL? {
		guard let raw = userInfo?[urlKey] as? String, let url = URL(string: raw),
			DeepLink(url: url) != nil
		else { return nil }
		return url
	}
}
