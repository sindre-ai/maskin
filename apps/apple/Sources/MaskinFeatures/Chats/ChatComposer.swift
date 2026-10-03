import MaskinCore
import MaskinDesign
import MaskinUI
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The thread's composer: chips (attachments, mentions) above a glass bar with a + menu (photos,
/// files), the text field, and send, which dictation (iOS) replaces while the field is empty.
/// Typing `@` opens the mention picker above it.
struct ChatComposer: View {
	@Bindable var model: ChatComposerModel
	let placeholder: String
	/// People and agents the `@` picker offers for a query.
	let suggestions: (String) -> [ChatParticipant]
	let inConversation: Set<String>
	let onSend: () -> Void

	@FocusState private var focused: Bool
	@State private var showPhotos = false
	@State private var showFiles = false
	@State private var photoItems: [PhotosPickerItem] = []
	@State private var listening = false
	var body: some View {
		VStack(spacing: MaskinSpace.s4) {
			if let match = MentionTrigger.find(in: model.text) {
				MentionSuggestions(
					candidates: suggestions(match.query), inConversation: inConversation,
					onPick: { person in
						model.pick(ChatMention(id: person.id, name: person.name, kind: person.kind))
						focused = true
					})
					.transition(.opacity.combined(with: .move(edge: .bottom)))
			}
			ComposerChips(model: model)
			bar
			if let notice = model.notice {
				Text(notice).maskinText(.caption).foregroundStyle(MaskinColor.danger)
					.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, MaskinSpace.s5)
					.onTapGesture { model.notice = nil }
			}
		}
		.animation(MaskinMotion.quick, value: MentionTrigger.find(in: model.text) != nil)
		.photosPicker(
			isPresented: $showPhotos, selection: $photoItems,
			maxSelectionCount: max(1, ChatLimits.maxAttachments - model.attachments.count),
			matching: .images)
		.fileImporter(
			isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true
		) { result in
			guard case .success(let urls) = result else { return }
			for url in urls {
				model.attach(
					name: url.lastPathComponent, mimeType: AttachmentLoading.mimeType(for: url),
					prepare: AttachmentLoading.file(at: url))
			}
		}
		.onChange(of: photoItems) { _, items in
			guard !items.isEmpty else { return }
			for (index, item) in items.enumerated() {
				let name = AttachmentLoading.photoName(index: index)
				model.attach(name: name, mimeType: "image/jpeg", prepare: AttachmentLoading.photo(item, name: name))
			}
			photoItems = []
		}
	}

	private var bar: some View {
		ComposerSurface(
			canSend: model.canSend, showsMic: listening || !model.canSend, onSend: onSend,
			leading: {
				Menu {
					Button { showPhotos = true } label: { Label("Photo", systemImage: "photo") }
					Button { showFiles = true } label: { Label("File", systemImage: "doc") }
				} label: {
					ComposerCircleLabel("plus")
				}
				.accessibilityLabel("Add photo or file")
			},
			field: {
				TextField(placeholder, text: $model.text, axis: .vertical)
					.lineLimit(1...6)
					.accessibilityLabel("Message")
					.focused($focused)
					.submitLabel(.return)
			},
			mic: { DictationButton(text: $model.text, listening: $listening) })
	}
}
