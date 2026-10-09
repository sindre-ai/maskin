import MaskinCore
import MaskinDesign
import MaskinUI
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
#endif

/// The shared composer: a floating glass pill with `+` (attach, mention, emoji, formatting, live
/// voice) on the left, the text field, a mic and Send on the right (Send turns dark once there is text).
/// While dictating the buttons become Discard (puts back the text from before) and Done (keeps the
/// text), with a red waveform and the editable transcript between them; dictation runs until one of
/// them is tapped. Live voice replaces the pill with a panel. Typing `@` or `:` opens a suggestion
/// list above it.
///
/// One view for every surface that composes a message (chat thread, object timeline, loop, For you
/// reply, Chief of Staff): configure it, do not fork it. `placeholder` words the field, `roster` says
/// whom `@` offers, `allowsAttach` shows or hides the file and photo items, `allowsLive` the live
/// conversation item.
struct ChatComposer: View {
	@Bindable var model: ChatComposerModel
	let placeholder: String
	/// People and agents the `@` picker offers for a query. Ignored when `roster` is set.
	var suggestions: (String) -> [ChatParticipant] = { _ in [] }
	/// People already in the conversation: listed first by the `@` picker.
	var inConversation: Set<String> = []
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
	/// Everyone `@` can tag (workspace members and agents, with their roles). Nil falls back to
	/// `suggestions`.
	var roster: MentionRoster?
	/// Photos, camera and files in the `+` menu.
	var allowsAttach = true
	/// "Start a live conversation" in the `+` menu (iOS only, and only with `showsVoiceControls`).
	var allowsLive = true
	/// Told when the field gains or loses focus (For you hides its quick-question chips while typing).
	var onFocusChange: ((Bool) -> Void)?

	/// Set once the reader acts; until then the preview state (idle in real use) stands.
	@State var voiceChoice: ComposerVoiceState?
	@State var muted = false
	/// The text from before the mic opened, put back by Discard.
	@State var textBeforeDictation = ""
	@State var dictationBase = ""
	#if os(iOS)
	@State var dictation = Dictation()
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

	/// 26pt, the pill's corner (shared with `ComposerSurface`).
	private let shape = RoundedRectangle(cornerRadius: MaskinRadius.hero + MaskinSpace.s4, style: .continuous)
	private let buttonSize = MaskinSpace.s14 + MaskinSpace.s3

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
				pill
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
		.onChange(of: focused) { _, now in onFocusChange?(now) }
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

	private func mentionCandidates(for query: String) -> [MentionPerson] {
		if let roster {
			return roster.candidates(query: query, selfID: model.selfActorID, prioritizing: inConversation)
				.filter { person in !model.mentions.contains { $0.id == person.id } }
		}
		return suggestions(query).prefix(MentionRoster.maxRows).map {
			MentionPerson(id: $0.id, name: $0.name, kind: $0.kind)
		}
	}

	@ViewBuilder
	private var suggestionList: some View {
		if voice != .dictating, let match = MentionTrigger.find(in: model.text) {
			MentionSuggestions(
				people: mentionCandidates(for: match.query),
				onPick: { person in
					model.pick(person.mention)
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

	// MARK: Pill

	private var pill: some View {
		VStack(alignment: .leading, spacing: 0) {
			if !model.attachments.isEmpty || !model.mentions.isEmpty {
				ComposerChips(model: model)
					.padding(.horizontal, MaskinSpace.s4)
					.padding(.top, MaskinSpace.s5)
			}
			HStack(alignment: .bottom, spacing: MaskinSpace.s2) {
				if voice == .dictating { discardButton } else { plusMenu }
				field
				trailing
			}
			.padding(MaskinSpace.s4)
			if showsFormatting && voice != .dictating {
				ComposerFormatRow(apply: model.applyFormat)
					.padding(.bottom, MaskinSpace.s3)
					.transition(.opacity.combined(with: .move(edge: .bottom)))
			}
		}
		.maskinGlass(in: shape)
		.overlay(shape.strokeBorder(focused ? MaskinColor.ruleStrong : Color.clear, lineWidth: 1))
	}

	/// The field. While dictating a red waveform leads it and the transcript is editable in place.
	private var field: some View {
		HStack(spacing: MaskinSpace.s5) {
			if voice == .dictating {
				VoiceWaveform(bars: 5, height: 22, tint: MaskinColor.dangerMic)
			}
			ComposerTextField(model: model, placeholder: voice == .dictating ? "Listening…" : placeholder, focused: $focused)
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink)
		}
		.padding(.horizontal, MaskinSpace.s3)
		.frame(minHeight: buttonSize, alignment: .center)
	}

	private var plusMenu: some View {
		Menu {
			if allowsAttach {
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
			}
			Button {
				let needsSpace = !(model.text.isEmpty || model.text.last?.isWhitespace == true)
				model.insert(needsSpace ? " @" : "@")
				focused = true
			} label: { Label("Mention an agent or person", systemImage: "at") }
			Button { showEmojis = true } label: { Label("Emoji", systemImage: "face.smiling") }
			Toggle(isOn: $showsFormatting) { Label("Formatting", systemImage: "textformat") }
			if allowsLive && showsVoiceControls {
				Divider()
				Button {
					MaskinHaptics.play(.medium)
					startLive()
				} label: { Label("Start a live conversation", systemImage: "waveform") }
			}
		} label: {
			ComposerToolLabel("plus", outlined: true)
		}
		.menuIndicator(.hidden)
		.buttonStyle(.maskinPressed)
		.accessibilityLabel(allowsAttach ? "Add a file, mention or emoji" : "Add a mention or emoji")
		.popover(isPresented: $showEmojis) {
			EmojiPickerGrid { emoji in
				model.insert(emoji)
				showEmojis = false
				focused = true
			}
			.presentationCompactAdaptation(.popover)
		}
	}

	/// While dictating: put back what was in the field before the mic opened.
	private var discardButton: some View {
		DictationDiscardButton(size: buttonSize) { discardDictation() }
	}

	/// The right-hand side: Done while dictating; otherwise a mic and Send, which turns dark once
	/// there is something to send.
	@ViewBuilder
	private var trailing: some View {
		if voice == .dictating {
			DictationDoneButton(size: buttonSize) { finishDictation() }
			.transition(.opacity)
		} else {
			HStack(spacing: MaskinSpace.s5) {
				if showsVoiceControls {
					Button {
						MaskinHaptics.play(.selection)
						toggleDictation()
					} label: {
						Image(systemName: "mic")
							.font(.system(size: MaskinFontSize.t16, weight: .medium))
							.foregroundStyle(MaskinColor.ink3)
							.frame(width: buttonSize, height: buttonSize)
							.background(MaskinSurface.fill, in: Circle())
							.contentShape(Circle())
					}
					.buttonStyle(.maskinPressed)
					.accessibilityLabel("Dictate")
				}
				sendButton
			}
		}
	}

	private var sendButton: some View {
		Button {
			MaskinHaptics.play(.light)
			onSend()
		} label: {
			Image(systemName: "arrow.up")
				.font(.system(size: MaskinFontSize.t15, weight: .bold))
				.foregroundStyle(model.canSend ? MaskinSurface.onInverse : MaskinColor.ink5)
				.frame(width: buttonSize, height: buttonSize)
				.background(model.canSend ? MaskinSurface.inverse : MaskinSurface.fill, in: Circle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(!model.canSend)
		#if !os(watchOS)
		.keyboardShortcut(.return, modifiers: .command)
		#endif
		.animation(MaskinMotion.quick, value: model.canSend)
		.accessibilityLabel("Send")
		.accessibilityHint(model.sendBlocker ?? "")
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
		textBeforeDictation = model.text
		dictationBase = model.text
		Task {
			await dictation.start(continuous: true) { model.text = DictationText.merge(base: dictationBase, transcript: $0) }
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

	/// Done: keep the text, ready to edit or send.
	fileprivate func finishDictation() {
		#if os(iOS)
		dictation.stop()
		#endif
		voice = .idle
		focused = true
	}

	/// Discard: stop and put back what was in the field before the mic opened.
	fileprivate func discardDictation() {
		#if os(iOS)
		dictation.stop()
		#endif
		model.text = textBeforeDictation
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
			// The recogniser can fail after it has started (no input, a dropped route). Dictating says so;
			// a live conversation restarts it quietly and only speaks up if it gives up.
			.onChange(of: composer.dictation.state) { _, state in
				guard case .unavailable(let message) = state else { return }
				composer.dictation.clearError()
				if composer.live?.isActive != true { composer.voiceProblem = message }
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
			.foregroundStyle(active ? MaskinColor.ink : MaskinColor.ink3)
			.frame(width: MaskinSpace.s14 + MaskinSpace.s3, height: MaskinSpace.s14 + MaskinSpace.s3)
			.background(active ? MaskinSurface.fillStrong : (outlined ? MaskinSurface.fill : Color.clear), in: Circle())
			.contentShape(Circle())
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
		.buttonStyle(.maskinPressed)
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
		return TextOffsets.characterOffsets(of: range, in: model.text)
	}

	private func textSelection(for range: Range<Int>) -> TextSelection {
		let text = model.text
		let lower = text.index(text.startIndex, offsetBy: min(range.lowerBound, text.count))
		let upper = text.index(text.startIndex, offsetBy: min(range.upperBound, text.count))
		return TextSelection(range: lower..<upper)
	}
}
