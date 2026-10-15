import SwiftUI

/// Tactile feedback. No-ops everywhere but iOS so shared code can call it freely.
///
/// Generators are kept alive and re-prepared after every fire. A fresh generator that fires
/// immediately has to spin up the Taptic Engine first, so the haptic can land after the visual
/// change; a prepared one fires on the same frame.
@MainActor
public enum MaskinHaptics {
	public enum Kind: Sendable { case light, medium, selection, success, warning, error }

	#if os(iOS)
	private static let light = UIImpactFeedbackGenerator(style: .light)
	private static let medium = UIImpactFeedbackGenerator(style: .medium)
	private static let selection = UISelectionFeedbackGenerator()
	private static let notification = UINotificationFeedbackGenerator()
	#endif

	/// Spins the engine up ahead of a likely `play` (touch-down, a card appearing). Cheap to repeat.
	public static func prepare(_ kind: Kind = .light) {
		#if os(iOS)
		switch kind {
		case .light: light.prepare()
		case .medium: medium.prepare()
		case .selection: selection.prepare()
		case .success, .warning, .error: notification.prepare()
		}
		#endif
	}

	public static func play(_ kind: Kind) {
		#if os(iOS)
		switch kind {
		case .light: light.impactOccurred()
		case .medium: medium.impactOccurred()
		case .selection: selection.selectionChanged()
		case .success: notification.notificationOccurred(.success)
		case .warning: notification.notificationOccurred(.warning)
		case .error: notification.notificationOccurred(.error)
		}
		prepare(kind)
		#endif
	}
}
