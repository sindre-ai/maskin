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
	#if os(iOS)
	@State private var dictation = Dictation()
	@State private var dictationBase = ""
	#endif

	private static let control = MaskinSpace.touchMin

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
			#if os(iOS)
			if case .unavailable(let message) = dictation.state {
				Text(message).maskinText(.caption).foregroundStyle(MaskinColor.danger)
					.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, MaskinSpace.s5)
					.onTapGesture { dictation.clearError() }
			}
			#endif
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
		HStack(alignment: .bottom, spacing: MaskinSpace.s4) {
			Menu {
				Button { showPhotos = true } label: { Label("Photo", systemImage: "photo") }
				Button { showFiles = true } label: { Label("File", systemImage: "doc") }
			} label: {
				Image(systemName: "plus")
					.font(.system(size: MaskinFontSize.t15, weight: .semibold))
					.foregroundStyle(MaskinColor.ink3)
					.frame(width: Self.control, height: Self.control)
					.background(MaskinSurface.fill, in: Circle())
			}
			.accessibilityLabel("Add photo or file")
			TextField(placeholder, text: $model.text, axis: .vertical)
				.lineLimit(1...5)
				.accessibilityLabel("Message")
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink)
				.frame(minHeight: Self.control)
				.focused($focused)
				.submitLabel(.return)
			#if os(iOS)
			if showsMic { micButton } else { sendButton }
			#else
			sendButton
			#endif
		}
		.padding(MaskinSpace.s3)
		.maskinGlass(in: RoundedRectangle(cornerRadius: MaskinRadius.hero + MaskinSpace.s4, style: .continuous))
	}

	#if os(iOS)
	/// The mic takes the send button's place while there is nothing to send.
	private var showsMic: Bool {
		dictation.isListening
			|| (model.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.attachments.isEmpty)
	}

	private var micButton: some View {
		Button {
			MaskinHaptics.play(.selection)
			if dictation.isListening {
				dictation.stop()
			} else {
				dictationBase = model.text
				Task {
					await dictation.start { transcript in
						model.text = DictationText.merge(base: dictationBase, transcript: transcript)
					}
				}
			}
		} label: {
			Image(systemName: dictation.isListening ? "waveform" : "mic")
				.symbolEffect(.pulse, isActive: dictation.isListening)
				.frame(width: Self.control, height: Self.control)
				.foregroundStyle(dictation.isListening ? MaskinColor.dangerMic : MaskinColor.ink3)
		}
		.buttonStyle(.plain)
		.accessibilityLabel(dictation.isListening ? "Stop dictation" : "Start dictation")
	}
	#endif

	private var sendButton: some View {
		Button {
			#if os(iOS)
			if dictation.isListening { dictation.stop() }
			#endif
			MaskinHaptics.play(.light)
			onSend()
		} label: {
			Image(systemName: "arrow.up")
				.font(.system(size: MaskinFontSize.t15, weight: .bold))
				.foregroundStyle(MaskinSurface.onInverse)
				.frame(width: Self.control, height: Self.control)
				.background(MaskinSurface.inverse, in: Circle())
				.opacity(model.canSend ? 1 : 0.35)
		}
		.buttonStyle(.plain)
		.disabled(!model.canSend)
		.keyboardShortcut(.return, modifiers: .command)
		.accessibilityLabel("Send")
		.accessibilityHint(model.sendBlocker ?? "")
	}
}
