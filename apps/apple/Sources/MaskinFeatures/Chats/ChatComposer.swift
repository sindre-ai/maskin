import MaskinCore
import MaskinDesign
import MaskinUI
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
#endif

/// The thread's composer: one calm card holding the attachments and the text field, with `+` below it
/// on the left (attach, mention, emoji, formatting) and, on the right, a mic and a live button while
/// there is nothing to send, a waveform and a checkmark while dictating, and Send once there is text.
/// Live voice replaces the card with a panel. Typing `@` or `:` opens a suggestion list above it.
struct ChatComposer: View {
	@Bindable var model: ChatComposerModel
	let placeholder: String
	/// People and agents the `@` picker offers for a query.
	let suggestions: (String) -> [ChatParticipant]
	let inConversation: Set<String>
	let onSend: () -> Void
	/// Whom a live conversation is with, for the panel's wording.
	var agentName = "Agent"
	/// The mic and live controls. They need the Speech framework, so they are iOS-only unless a
	/// preview asks for them.
	var showsVoiceControls: Bool = {
		#if os(iOS)
		true
		#else
		false
		#endif
	}()
	/// Starts a preview in this voice state (design review); real use starts idle.
	var previewVoice: ComposerVoiceState = .idle
	/// The latest messages, so a live conversation can hear the agent's reply arrive.
	var replies: [ChatMessage] = []

	/// Set once the reader acts; until then the preview state (idle in real use) stands.
	@State var voiceChoice: ComposerVoiceState?
	@State var muted = false
	#if os(iOS)
	@State var dictation = Dictation()
	@State var dictationBase = ""
	@State var live: LiveVoiceController?
	@State var showCamera = false
	@Environment(\.openURL) var openURL
	#endif
	/// What went wrong with dictation or a live conversation, shown once with a way to Settings.
	@State var voiceProblem: String?
	@FocusState private var focused: Bool
	@State private var showPhotos = false
	@State private var showFiles = false
	@State private var showEmojis = false
	@State private var photoItems: [PhotosPickerItem] = []
	@AppStorage("chat.formatting") private var showsFormatting = false

	var voice: ComposerVoiceState {
		get { voiceChoice ?? previewVoice }
		nonmutating set { voiceChoice = newValue }
	}

	private let shape = RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous)

	var body: some View {
		VStack(spacing: MaskinSpace.s4) {
			suggestionList
			if let panel = livePanel {
				LiveVoicePanel(
					phase: panel.phase, agentName: agentName, transcript: panel.transcript, muted: panel.muted,
					onToggleMute: toggleLiveMute, onEnd: endLive, onInterrupt: interruptLive
				)
				.transition(.opacity.combined(with: .scale(scale: 0.98)))
			} else {
				card
			}
			if let notice = model.notice {
				Text(notice).maskinText(.caption).foregroundStyle(MaskinColor.danger)
					.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, MaskinSpace.s5)
					.onTapGesture { model.notice = nil }
			}
		}
		.animation(MaskinMotion.quick, value: MentionTrigger.find(in: model.text) != nil)
		.animation(MaskinMotion.quick, value: EmojiTrigger.find(in: model.text) != nil)
		.animation(MaskinMotion.quick, value: showsFormatting)
		.animation(MaskinMotion.standard, value: voice)
		.onChange(of: model.focusRequest) { _, _ in focused = true }
		.voiceLifecycle(self)
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

	// MARK: Suggestions

	@ViewBuilder
	private var suggestionList: some View {
		if let match = MentionTrigger.find(in: model.text) {
			MentionSuggestions(
				candidates: suggestions(match.query), inConversation: inConversation,
				onPick: { person in
					model.pick(ChatMention(id: person.id, name: person.name, kind: person.kind))
					focused = true
				}
			)
			.transition(.opacity.combined(with: .move(edge: .bottom)))
		} else if let match = EmojiTrigger.find(in: model.text) {
			let found = EmojiShortcodes.suggestions(for: match.query, limit: 5)
			if !found.isEmpty {
				EmojiSuggestions(items: found) { model.pickEmoji($0.emoji) }
					.transition(.opacity.combined(with: .move(edge: .bottom)))
			}
		}
	}

	// MARK: Card

	private var card: some View {
		VStack(alignment: .leading, spacing: 0) {
			if !model.attachments.isEmpty || !model.mentions.isEmpty {
				ComposerChips(model: model)
					.padding(.horizontal, MaskinSpace.s5)
					.padding(.top, MaskinSpace.s5)
			}
			ComposerTextField(model: model, placeholder: placeholder, focused: $focused)
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink)
				.padding(.horizontal, MaskinSpace.s8)
				.padding(.top, MaskinSpace.s7)
				.padding(.bottom, MaskinSpace.s4)
			if showsFormatting {
				ComposerFormatRow(apply: model.applyFormat)
					.transition(.opacity.combined(with: .move(edge: .bottom)))
			}
			toolRow
		}
		.background(MaskinSurface.card, in: shape)
		.overlay(shape.strokeBorder(focused ? MaskinColor.ruleStrong : MaskinSurface.line, lineWidth: 1))
	}

	private var toolRow: some View {
		HStack(spacing: MaskinSpace.s1) {
			Menu {
				Button { showPhotos = true } label: { Label("Photo library", systemImage: "photo") }
				#if os(iOS)
				if CameraPicker.isAvailable {
					Button { showCamera = true } label: { Label("Take photo", systemImage: "camera") }
				}
				if UIPasteboard.general.hasImages {
					Button(action: pasteImage) { Label("Paste image", systemImage: "doc.on.clipboard") }
				}
				#endif
				Button { showFiles = true } label: { Label("File", systemImage: "doc") }
				Divider()
				Button {
					let needsSpace = !(model.text.isEmpty || model.text.last?.isWhitespace == true)
					model.insert(needsSpace ? " @" : "@")
					focused = true
				} label: { Label("Mention an agent or person", systemImage: "at") }
				Button { showEmojis = true } label: { Label("Emoji", systemImage: "face.smiling") }
				Toggle(isOn: $showsFormatting) { Label("Formatting", systemImage: "textformat") }
			} label: {
				ComposerToolLabel("plus", outlined: true)
			}
			.menuIndicator(.hidden)
			.buttonStyle(.plain)
			.accessibilityLabel("Add a file, mention or emoji")
			.popover(isPresented: $showEmojis) {
				EmojiPickerGrid { emoji in
					model.insert(emoji)
					showEmojis = false
					focused = true
				}
				.presentationCompactAdaptation(.popover)
			}
			Spacer(minLength: 0)
			trailing
		}
		.padding(.horizontal, MaskinSpace.s3)
		.padding(.bottom, MaskinSpace.s3)
		.animation(MaskinMotion.quick, value: model.canSend)
		.animation(MaskinMotion.quick, value: voice)
	}

	/// The right-hand side: Send once there is text; a waveform and checkmark while dictating; a mic and
	/// a live button otherwise. The two voice buttons look different on purpose: the mic is a quiet glyph
	/// that types for you, live is a filled button that starts a conversation.
	@ViewBuilder
	private var trailing: some View {
		if voice == .dictating {
			HStack(spacing: MaskinSpace.s5) {
				VoiceWaveform(bars: 5, height: 22, tint: MaskinColor.accent)
				Button {
					MaskinHaptics.play(.selection)
					finishDictation()
				} label: {
					Image(systemName: "checkmark")
						.font(.system(size: MaskinFontSize.t15, weight: .bold))
						.foregroundStyle(MaskinSurface.onInverse)
						.frame(width: MaskinSpace.s14 + MaskinSpace.s2, height: MaskinSpace.s14 + MaskinSpace.s2)
						.background(MaskinColor.accent, in: Circle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Finish dictation")
			}
			.transition(.opacity)
		} else if model.canSend {
			Button {
				MaskinHaptics.play(.light)
				onSend()
			} label: {
				Image(systemName: "arrow.up")
					.font(.system(size: MaskinFontSize.t15, weight: .bold))
					.foregroundStyle(MaskinSurface.onInverse)
					.frame(width: MaskinSpace.s14 + MaskinSpace.s2, height: MaskinSpace.s14 + MaskinSpace.s2)
					.background(MaskinColor.accent, in: Circle())
			}
			.buttonStyle(.plain)
			.transition(.scale.combined(with: .opacity))
			#if !os(watchOS)
			.keyboardShortcut(.return, modifiers: .command)
			#endif
			.accessibilityLabel("Send")
			.accessibilityHint(model.sendBlocker ?? "")
		} else if showsVoiceControls {
			HStack(spacing: MaskinSpace.s2) {
				Button {
					MaskinHaptics.play(.selection)
					toggleDictation()
				} label: {
					Image(systemName: "mic")
						.font(.system(size: MaskinFontSize.t16, weight: .medium))
						.foregroundStyle(MaskinColor.ink3)
						.frame(width: MaskinSpace.s14 + MaskinSpace.s2, height: MaskinSpace.s14 + MaskinSpace.s2)
						.contentShape(Circle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Dictate")
				Button {
					MaskinHaptics.play(.medium)
					startLive()
				} label: {
					Image(systemName: "waveform")
						.font(.system(size: MaskinFontSize.t15, weight: .semibold))
						.foregroundStyle(MaskinSurface.onInverse)
						.frame(width: MaskinSpace.s14 + MaskinSpace.s2, height: MaskinSpace.s14 + MaskinSpace.s2)
						.background(MaskinSurface.inverse, in: Circle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Start a live conversation")
			}
			.transition(.opacity)
		}
	}
}

// MARK: - Voice

extension ChatComposer {
	/// The live panel's content: the real conversation when one is running, the preview state in design review.
	fileprivate var livePanel: (phase: LiveVoicePhase, transcript: String, muted: Bool)? {
		#if os(iOS)
		if let live, live.isActive { return (live.phase, live.transcript, live.isMuted) }
		#endif
		if case .live(let phase) = voice { return (phase, model.text, muted) }
		return nil
	}

	fileprivate func toggleDictation() {
		#if os(iOS)
		if dictation.isListening {
			finishDictation()
			return
		}
		dictationBase = model.text
		Task {
			await dictation.start { model.text = DictationText.merge(base: dictationBase, transcript: $0) }
			if case .unavailable(let message) = dictation.state {
				voiceProblem = message
				dictation.clearError()
			}
			voice = dictation.isListening ? .dictating : .idle
		}
		#else
		voice = voice == .dictating ? .idle : .dictating
		#endif
	}

	fileprivate func finishDictation() {
		#if os(iOS)
		dictation.stop()
		#endif
		voice = .idle
	}

	fileprivate func startLive() {
		#if os(iOS)
		guard live == nil else { return }
		let dictation = dictation
		let model = model
		let onSend = onSend
		let controller = LiveVoiceController(
			ports: LiveVoiceController.Ports(
				startListening: { onText in
					await dictation.start(onText: onText)
					if case .unavailable(let message) = dictation.state {
						dictation.clearError()
						return message
					}
					return nil
				},
				stopListening: { dictation.stop() },
				isListening: { dictation.isListening },
				speak: { id, markdown in SpeechReader.shared.enqueue(markdown: markdown, id: id) },
				stopSpeaking: { SpeechReader.shared.stop() },
				isSpeaking: { SpeechReader.shared.speakingID != nil },
				send: { text in
					model.text = text
					onSend()
				}))
		live = controller
		focused = false
		controller.begin(existing: replies)
		#else
		voice = .live(.listening)
		#endif
	}

	fileprivate func endLive() {
		#if os(iOS)
		live?.end()
		live = nil
		#endif
		voice = .idle
	}

	fileprivate func toggleLiveMute() {
		#if os(iOS)
		if let live {
			live.toggleMute()
			return
		}
		#endif
		muted.toggle()
	}

	fileprivate func interruptLive() {
		#if os(iOS)
		live?.interrupt()
		#endif
	}

	#if os(iOS)
	fileprivate func pasteImage() {
		guard let image = UIPasteboard.general.image, let data = image.jpegData(compressionQuality: 0.9) else { return }
		addPhoto(data, name: "Pasted image.jpg")
	}

	fileprivate func addPhoto(_ data: Data, name: String? = nil) {
		let name = name ?? AttachmentLoading.photoName(index: 0)
		model.attach(name: name, mimeType: "image/jpeg", prepare: AttachmentLoading.image(data: data, name: name))
	}
	#endif
}

/// Keeps dictation and a live conversation tidy: stops them when the composer goes away, hands the
/// agent's replies to the conversation, ends dictation that stopped by itself, and explains a failure.
private struct VoiceLifecycle: ViewModifier {
	let composer: ChatComposer

	func body(content: Content) -> some View {
		#if os(iOS)
		content
			.onDisappear {
				composer.dictation.stop()
				composer.live?.end()
			}
			.onChange(of: composer.replies.map(\.id)) { _, _ in composer.live?.messagesChanged(composer.replies) }
			.onChange(of: composer.dictation.isListening) { _, listening in
				if !listening, composer.voice == .dictating { composer.voice = .idle }
			}
			.onChange(of: composer.live?.isActive) { _, active in
				guard active == false, let live = composer.live else { return }
				if let failure = live.failure { composer.voiceProblem = failure }
				composer.live = nil
			}
			.fullScreenCover(isPresented: composer.$showCamera) {
				CameraPicker { composer.addPhoto($0) }.ignoresSafeArea()
			}
			.alert("Voice", isPresented: Binding(get: { composer.voiceProblem != nil }, set: { if !$0 { composer.voiceProblem = nil } })) {
				Button("Open Settings") {
					if let url = URL(string: UIApplication.openSettingsURLString) { composer.openURL(url) }
				}
				Button("OK", role: .cancel) {}
			} message: {
				Text(composer.voiceProblem ?? "")
			}
		#else
		content
		#endif
	}
}

private extension View {
	func voiceLifecycle(_ composer: ChatComposer) -> some View { modifier(VoiceLifecycle(composer: composer)) }
}

/// A tool in the composer's row: a quiet glyph, tinted when its panel is open; the plus has a fill.
struct ComposerToolLabel: View {
	let symbol: String
	var active = false
	var outlined = false

	init(_ symbol: String, active: Bool = false, outlined: Bool = false) {
		self.symbol = symbol
		self.active = active
		self.outlined = outlined
	}

	var body: some View {
		Image(systemName: symbol)
			.font(.system(size: MaskinFontSize.t16, weight: .medium))
			.foregroundStyle(active ? MaskinColor.accentStrong : MaskinColor.ink3)
			.frame(width: MaskinSpace.s14, height: MaskinSpace.s14)
			.background(active ? MaskinColor.accentTint : Color.clear, in: Circle())
			.overlay { if outlined { Circle().strokeBorder(MaskinSurface.line, lineWidth: 1) } }
			.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin - MaskinSpace.s2)
			.contentShape(Rectangle())
	}
}

/// The formatting row: inline styles, then block styles. Each applies to the selection.
struct ComposerFormatRow: View {
	let apply: (MarkdownFormat) -> Void

	private let inline: [(MarkdownFormat, String, String)] = [
		(.bold, "bold", "Bold"), (.italic, "italic", "Italic"), (.strikethrough, "strikethrough", "Strikethrough"),
		(.code, "chevron.left.forwardslash.chevron.right", "Code"), (.link, "link", "Link"),
	]
	private let blocks: [(MarkdownFormat, String, String)] = [
		(.bullet, "list.bullet", "Bulleted list"), (.numbered, "list.number", "Numbered list"),
		(.quote, "text.quote", "Quote"), (.codeBlock, "curlybraces", "Code block"),
	]

	var body: some View {
		VStack(spacing: 0) {
			Rectangle().fill(MaskinSurface.line).frame(height: 1)
			ScrollView(.horizontal, showsIndicators: false) {
				HStack(spacing: MaskinSpace.s1) {
					ForEach(inline, id: \.1) { button($0) }
					Rectangle().fill(MaskinSurface.line).frame(width: 1, height: MaskinSpace.s11)
						.padding(.horizontal, MaskinSpace.s3)
					ForEach(blocks, id: \.1) { button($0) }
				}
				.padding(.horizontal, MaskinSpace.s3)
			}
		}
	}

	private func button(_ item: (MarkdownFormat, String, String)) -> some View {
		Button {
			MaskinHaptics.play(.selection)
			apply(item.0)
		} label: {
			Image(systemName: item.1)
				.font(.system(size: MaskinFontSize.t15, weight: .medium))
				.foregroundStyle(MaskinColor.ink3)
				.frame(width: MaskinSpace.s13 + MaskinSpace.s3, height: MaskinSpace.touchMin - MaskinSpace.s2)
				.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel(item.2)
	}
}

/// The message field. From iOS 18 it reports the selection so a format wraps the chosen words; before
/// that a format acts at the end of the text.
struct ComposerTextField: View {
	@Bindable var model: ChatComposerModel
	let placeholder: String
	var focused: FocusState<Bool>.Binding

	var body: some View {
		if #available(iOS 18, macOS 15, *) {
			SelectionTextField(model: model, placeholder: placeholder, focused: focused)
		} else {
			TextField(placeholder, text: $model.text, axis: .vertical)
				.textFieldStyle(.plain)
				.lineLimit(1...8)
				.accessibilityLabel("Message")
				.focused(focused)
		}
	}
}

@available(iOS 18, macOS 15, *)
private struct SelectionTextField: View {
	@Bindable var model: ChatComposerModel
	let placeholder: String
	var focused: FocusState<Bool>.Binding
	@State private var selection: TextSelection?

	var body: some View {
		TextField(placeholder, text: $model.text, selection: $selection, axis: .vertical)
			.textFieldStyle(.plain)
			.lineLimit(1...8)
			.accessibilityLabel("Message")
			.focused(focused)
			.onChange(of: selection) { _, new in model.selection = offsets(of: new) }
			.onChange(of: model.selectionRequest) { _, request in
				guard let request else { return }
				selection = textSelection(for: request.range)
			}
	}

	private func offsets(of selection: TextSelection?) -> Range<Int>? {
		guard let selection, case .selection(let range) = selection.indices else { return nil }
		let text = model.text
		return text.distance(from: text.startIndex, to: range.lowerBound)..<text.distance(from: text.startIndex, to: range.upperBound)
	}

	private func textSelection(for range: Range<Int>) -> TextSelection {
		let text = model.text
		let lower = text.index(text.startIndex, offsetBy: min(range.lowerBound, text.count))
		let upper = text.index(text.startIndex, offsetBy: min(range.upperBound, text.count))
		return TextSelection(range: lower..<upper)
	}
}
