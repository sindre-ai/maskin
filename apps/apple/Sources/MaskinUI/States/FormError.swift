import MaskinDesign
import SwiftUI

/// Inline form error. Renders nothing for a nil/empty message.
public struct FormError: View {
	private let message: String?

	public init(_ message: String?) { self.message = message }

	public var body: some View {
		if let message, !message.isEmpty {
			Label {
				Text(message).maskinText(.subhead)
			} icon: {
				Image(systemName: "exclamationmark.circle.fill")
			}
			.foregroundStyle(MaskinColor.dangerStrong)
			.frame(maxWidth: .infinity, alignment: .leading)
			.accessibilityElement(children: .combine)
			.accessibilityLabel("Error: \(message)")
		}
	}
}

#Preview("FormError — light") {
	FormError("Couldn't save. Check your connection and try again.").padding().preferredColorScheme(.light)
}
#Preview("FormError — dark") {
	FormError("Couldn't save. Check your connection and try again.").padding().preferredColorScheme(.dark)
}
