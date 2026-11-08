import MaskinCore
import SwiftUI

extension AppearancePreference {
	/// `nil` leaves the device setting in charge.
	var colorScheme: ColorScheme? {
		switch self {
		case .system: nil
		case .light: .light
		case .dark: .dark
		}
	}
}
