import SwiftUI

/// An identifiable id, for `.sheet(item:)` over a plain string.
struct PresentedID: Identifiable, Equatable {
	let id: String
}

/// A screen that pushes onto the caller's navigation (an agent, a file) shown in a sheet: gives it
/// its own stack and a Done button.
struct DetailSheet<Content: View>: View {
	@Environment(\.dismiss) private var dismiss
	@ViewBuilder let content: () -> Content

	var body: some View {
		NavigationStack {
			content()
				.toolbar {
					ToolbarItem(placement: .confirmationAction) {
						Button("Done") { dismiss() }
					}
				}
		}
	}
}
