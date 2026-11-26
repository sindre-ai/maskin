import Foundation

/// The two actions in the menu a long press on the Maskin icon opens. The same strings are the
/// `UIApplicationShortcutItemType` of the static items in `project.yml`: change one, change the other.
///
/// Static items carry no workspace, so these are not `DeepLink`s: the app applies them to the
/// workspace it has open.
public enum HomeScreenQuickAction: String, CaseIterable, Equatable, Sendable {
	case newMessage = "io.maskin.app.quick-action.new-message"
	case forYou = "io.maskin.app.quick-action.for-you"

	public init?(shortcutType: String) { self.init(rawValue: shortcutType) }
}

/// Hands a quick action to the app. The scene delegate calls `perform` when the system delivers the
/// tap; the app registers `handler` once its runtime exists. A tap that launched the app cold has no
/// runtime yet, so it waits in `pending` and is replayed by `attach`.
@MainActor
public enum HomeScreenQuickActionRelay {
	public private(set) static var pending: HomeScreenQuickAction?
	private static var handler: ((HomeScreenQuickAction) -> Void)?

	public static func attach(_ handler: @escaping (HomeScreenQuickAction) -> Void) {
		self.handler = handler
		if let action = pending {
			pending = nil
			handler(action)
		}
	}

	public static func perform(_ action: HomeScreenQuickAction) {
		if let handler { handler(action) } else { pending = action }
	}

	/// Test seam: forget the handler and anything waiting.
	static func reset() {
		handler = nil
		pending = nil
	}
}
