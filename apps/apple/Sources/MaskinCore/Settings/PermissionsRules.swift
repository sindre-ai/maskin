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
	case microphone, speechRecognition, camera, photos, faceID, notifications, liveActivities,
		backgroundRefresh, cellularData, paste

	public var id: String { rawValue }

	public var title: String {
		switch self {
		case .microphone: "Microphone"
		case .speechRecognition: "Speech Recognition"
		case .camera: "Camera"
		case .photos: "Photos"
		case .faceID: "Face ID"
		case .notifications: "Notifications"
		case .liveActivities: "Live Activities"
		case .backgroundRefresh: "Background App Refresh"
		case .cellularData: "Cellular Data"
		case .paste: "Paste from other apps"
		}
	}

	/// The line under the title: what Maskin uses it for.
	public var note: String {
		switch self {
		case .microphone: "Dictate messages and talk with agents in a call"
		case .speechRecognition: "Turn your speech into message text when you dictate"
		case .camera: "Take a photo or scan a document to attach to a message"
		case .photos: "Maskin sees only the photos you pick, so iOS never asks"
		case .faceID: "Unlock the app when you turn on app lock"
		case .notifications: "Decisions and replies reach you when they matter"
		case .liveActivities: "Follow an agent's turn from the Lock Screen"
		case .backgroundRefresh: "Top up For You while the app is closed"
		case .cellularData: "Use Maskin when you are away from Wi-Fi"
		case .paste: "Paste text and images without a prompt each time"
		}
	}

	/// False where iOS gives an app no way to read the choice: the row then shows no state.
	/// Face ID, Live Activities, Background App Refresh and Cellular Data are button-only rows too.
	/// Photos is not asked either: the photo picker runs outside Maskin and shares only what is picked.
	public var isReadable: Bool {
		switch self {
		case .microphone, .speechRecognition, .camera, .notifications: true
		case .photos, .faceID, .liveActivities, .backgroundRefresh, .cellularData, .paste: false
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
