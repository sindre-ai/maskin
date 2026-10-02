import SwiftUI

/// Tactile feedback. No-ops everywhere but iOS so shared code can call it freely.
@MainActor
public enum MaskinHaptics {
	public enum Kind: Sendable { case light, medium, selection, success, warning, error }

	public static func play(_ kind: Kind) {
		#if os(iOS)
		switch kind {
		case .light: UIImpactFeedbackGenerator(style: .light).impactOccurred()
		case .medium: UIImpactFeedbackGenerator(style: .medium).impactOccurred()
		case .selection: UISelectionFeedbackGenerator().selectionChanged()
		case .success: UINotificationFeedbackGenerator().notificationOccurred(.success)
		case .warning: UINotificationFeedbackGenerator().notificationOccurred(.warning)
		case .error: UINotificationFeedbackGenerator().notificationOccurred(.error)
		}
		#endif
	}
}
