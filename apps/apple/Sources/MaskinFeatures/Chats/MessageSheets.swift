import MaskinCore
import MaskinDesign
import SwiftUI

/// Edit the words of a message you sent. Save is offered only for a real change.
struct EditMessageSheet: View {
	let original: String
	let onSave: (String) -> Void
	@Environment(\.dismiss) private var dismiss
	@State private var text: String
	@FocusState private var focused: Bool

	init(original: String, onSave: @escaping (String) -> Void) {
		self.original = original
		self.onSave = onSave
		_text = State(initialValue: original)
	}

	private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
	private var canSave: Bool {
		!trimmed.isEmpty && trimmed != original.trimmingCharacters(in: .whitespacesAndNewlines)
			&& trimmed.count <= ChatLimits.maxMessageLength
	}

	var body: some View {
		NavigationStack {
			TextEditor(text: $text)
				.maskinText(.body)
				.focused($focused)
				.scrollContentBackground(.hidden)
				.padding(.horizontal, MaskinSpace.s8)
				.padding(.vertical, MaskinSpace.s5)
				.ambientBackground(showsBottom: false)
				.navigationTitle("Edit message")
				#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
				#endif
				.toolbar {
					ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
					ToolbarItem(placement: .confirmationAction) {
						Button("Save") {
							onSave(trimmed)
							MaskinHaptics.play(.success)
							dismiss()
						}
						.disabled(!canSave)
					}
				}
		}
		.onAppear { focused = true }
		#if os(iOS)
		.presentationDetents([.medium, .large])
		#endif
	}
}

/// A message's text with word-level selection. In the thread a long-press opens the message
/// menu, so selecting part of a message happens here.
struct SelectTextSheet: View {
	let text: String
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			ScrollView {
				Text(text)
					.maskinText(.body)
					.foregroundStyle(MaskinColor.ink)
					.textSelection(.enabled)
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(MaskinSpace.s9)
			}
			.ambientBackground(showsBottom: false)
			.navigationTitle("Select text")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
			}
		}
		#if os(iOS)
		.presentationDetents([.medium, .large])
		#endif
	}
}
