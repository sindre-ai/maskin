import Foundation

/// How the app picks light or dark. Follow device is the default; the account menu's Appearance row
/// cycles Follow device → Light → Dark and the choice is kept across launches.
public enum AppearancePreference: String, CaseIterable, Sendable {
	case system, light, dark

	/// The `UserDefaults` key the choice lives under (also read by `@AppStorage`).
	public static let storageKey = "maskin.appearance"

	public var title: String {
		switch self {
		case .system: "Follow device"
		case .light: "Light"
		case .dark: "Dark"
		}
	}

	public var symbol: String {
		switch self {
		case .system: "circle.lefthalf.filled"
		case .light: "sun.max"
		case .dark: "moon"
		}
	}

	/// The next choice when the row is tapped.
	public var next: AppearancePreference {
		switch self {
		case .system: .light
		case .light: .dark
		case .dark: .system
		}
	}

	/// The stored choice; anything unknown means Follow device.
	public static func stored(in defaults: UserDefaults = .standard) -> AppearancePreference {
		defaults.string(forKey: storageKey).flatMap(AppearancePreference.init(rawValue:)) ?? .system
	}
}
