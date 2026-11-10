import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What the object card adds when its text can be changed: the text itself (tap to edit, saved when
/// the sheet is saved) and a button for the next phase in the workspace's own order. The server
/// tells the agent behind the card (`chat`); nothing is posted in the chat. Same as the web card.
struct LinkedObjectActions: View {
	let object: LinkedObject
	let chat: ObjectPatchChat?
	@Environment(\.linkedItems) private var store
	@State private var order: [String] = []
	@State private var editingText = false

	private var busy: Bool { store?.editing.contains(object.target.uuid) == true }
	private var next: String? { LinkedObject.nextStatus(after: object.status, in: order) }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			if let content = object.content {
				Button { editingText = true } label: {
					Text(content)
						.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
						.foregroundStyle(MaskinColor.ink2)
						.lineLimit(12)
						.multilineTextAlignment(.leading)
						.frame(maxWidth: .infinity, alignment: .leading)
						.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed)
				.accessibilityLabel("Edit text")
				.accessibilityHint("Opens the text to change")
			}
			HStack(spacing: MaskinSpace.s4) {
				if let next { moveButton(to: next) }
				Spacer(minLength: 0)
				if busy { ProgressView().controlSize(.small) }
			}
			if let failure = store?.editFailures[object.target.uuid] {
				Text(failure).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
		}
		.task(id: object.type) { order = await store?.statusOrder(forType: object.type) ?? [] }
		.sheet(isPresented: $editingText) {
			LinkedTextEditSheet(initial: object.content ?? "", title: object.displayTitle) { text in
				await store?.saveText(objectID: object.target.uuid, text: text, chat: chat) ?? false
			}
		}
	}

	private func moveButton(to status: String) -> some View {
		Button {
			MaskinHaptics.play(.selection)
			Task { await store?.move(objectID: object.target.uuid, to: status, chat: chat) }
		} label: {
			Text("Move to \(MaskinStatus.sentenceLabel(for: status))")
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(MaskinColor.ink)
				.padding(.horizontal, MaskinSpace.s7)
				.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s3)
				.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
		}
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(busy || store == nil)
		.accessibilityLabel("Move to \(MaskinStatus.sentenceLabel(for: status))")
	}
}

/// The text of a linked object in a box. Save keeps the sheet open when the save fails.
private struct LinkedTextEditSheet: View {
	let initial: String
	let title: String
	let save: (String) async -> Bool
	@Environment(\.dismiss) private var dismiss
	@State private var text: String
	@State private var saving = false

	init(initial: String, title: String, save: @escaping (String) async -> Bool) {
		self.initial = initial
		self.title = title
		self.save = save
		_text = State(initialValue: initial)
	}

	var body: some View {
		NavigationStack {
			TextEditor(text: $text)
				.padding(MaskinSpace.s5)
				.navigationTitle(title)
				#if os(iOS)
					.navigationBarTitleDisplayMode(.inline)
				#endif
				.toolbar {
					ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
					ToolbarItem(placement: .confirmationAction) {
						Button("Save") {
							saving = true
							Task {
								if await save(text) { dismiss() }
								saving = false
							}
						}
						.disabled(saving || text == initial || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
					}
				}
		}
	}
}
