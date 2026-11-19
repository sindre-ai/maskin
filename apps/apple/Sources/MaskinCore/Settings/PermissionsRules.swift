import Foundation

/// What iOS says about one permission, as the Permissions page shows it.
public enum PermissionStatus: Equatable, Sendable {
	case allowed, denied, notAsked

	/// The trailing word on the row.
	public var pageState: PageState {
		switch self {
		case .allowed: PageState("Allowed", .active)
		case .denied: PageState("Denied", .notice)
		case .notAsked: PageState("Not asked yet", .muted)
		}
	}
}

/// The phone permissions the Permissions page lists, in order.
public enum PermissionKind: String, CaseIterable, Hashable, Identifiable, Sendable {
	case microphone, camera, photos, notifications, paste

	public var id: String { rawValue }

	public var title: String {
		switch self {
		case .microphone: "Microphone"
		case .camera: "Camera"
		case .photos: "Photos"
		case .notifications: "Notifications"
		case .paste: "Paste from other apps"
		}
	}

	/// The line under the title: what Maskin uses it for.
	public var note: String {
		switch self {
		case .microphone: "Dictate messages and talk with agents in a call"
		case .camera: "Take a photo to attach to a message"
		case .photos: "Maskin sees only the photos you pick, so iOS never asks"
		case .notifications: "Decisions and replies reach you when they matter"
		case .paste: "Paste text and images without a prompt each time"
		}
	}

	/// False where iOS gives an app no way to read the choice: the row then shows no state.
	/// Photos is not asked either: the photo picker runs outside Maskin and shares only what is picked.
	public var isReadable: Bool {
		switch self {
		case .microphone, .camera, .notifications: true
		case .photos, .paste: false
		}
	}
}

public enum PermissionsRules {
	/// The footnote under the list: the one thing the page cannot show.
	public static let pasteFootnote =
		"iOS does not let an app read or change the Paste choice. In Settings, open Maskin, then Paste from Other Apps, and pick Allow."

	/// The line over the button when a permission is off.
	public static let deniedFootnote =
		"A permission marked Denied stays off until you turn it on in iOS Settings."

	/// The deniedFootnote shows only while something is denied.
	public static func showsDeniedFootnote(_ statuses: [PermissionKind: PermissionStatus]) -> Bool {
		statuses.values.contains(.denied)
	}
}
