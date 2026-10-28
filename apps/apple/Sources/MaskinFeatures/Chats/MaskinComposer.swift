import MaskinCore
import MaskinDesign
import MaskinUI
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
#endif

/// Floating (glass, over a thread) or inline (a filled card inside a sheet or a feed card).
public enum MaskinComposerVariant: Sendable { case floating, inline }

/// How a host dresses the one composer. Spec 7 §1 → the use table.
public struct MaskinComposerConfig {
	public var variant: MaskinComposerVariant = .floating
	/// "Message {name}"; "Reply in thread"; "Type your answer…".
	public var placeholder: String
	public var showsAttach = true
	public var showsMic = true
	/// False for the Hold reason field, whose sheet commits the text.
	public var showsSend = true
	/// Team room only: a waveform button that starts a live conversation, shown while the field is empty.
	public var goLive: (() -> Void)? = nil
	/// People and agents the `@` popover offers for a query.
	public var suggestions: (String) -> [ChatParticipant] = { _ in [] }
	/// Who is already in the conversation: the popover lists them first.
	public var inConversation: Set<String> = []
	/// Everyone `@` can tag, with roles. When set it replaces `suggestions`.
	public var roster: MentionRoster? = nil
	/// Told when the field gains or loses focus (For you hides its quick-question chips while typing).
	public var onFocusChange: ((Bool) -> Void)? = nil

	public init(
		variant: MaskinComposerVariant = .floating, placeholder: String, showsAttach: Bool = true,
		showsMic: Bool = true, showsSend: Bool = true, goLive: (() -> Void)? = nil,
		suggestions: @escaping (String) -> [ChatParticipant] = { _ in [] }, inConversation: Set<String> = [],
		roster: MentionRoster? = nil, onFocusChange: ((Bool) -> Void)? = nil
	) {
		self.variant = variant
		self.placeholder = placeholder
		self.showsAttach = showsAttach
		self.showsMic = showsMic
		self.showsSend = showsSend
		self.goLive = goLive
		self.suggestions = suggestions
		self.inConversation = inConversation
		self.roster = roster
		self.onFocusChange = onFocusChange
	}
}

/// The one composer, everywhere a message is typed (spec 7 §1). Left to right, bottom-aligned as
/// the field grows: `[+] [field] [Go live?] [mic | send | stop]`. The quote strip and attachment
/// chips sit inside the bar above the field; the `+` menu and the `@` popover float 8pt above it.
///
/// **Embedding.** Pin it to the keyboard from the host:
/// ```swift
/// ScrollView { … }
///     .scrollDismissesKeyboard(.interactively)   // drag the list down to dismiss
///     .safeAreaInset(edge: .bottom) {
///         MaskinComposer(model: composer, config: config, busy: store.isWorking, onStop: stop, onSend: send)
///             .padding(.horizontal, MaskinSpace.s7).padding(.bottom, MaskinSpace.s4)
///     }
/// ```
/// The host owns `onSend` (call `model.take()`), `busy` (agent typing, streaming or working) and
/// `onStop`. Call `model.bind(conversationID:)` once so the draft is restored and saved per chat.
struct MaskinComposer: View {
	@Bindable var model: ChatComposerModel
	let config: MaskinComposerConfig
	/// An agent is typing, streaming or working: Stop takes the last slot while the field is empty.
	var busy = false
	var onStop: (() -> Void)?
	let onSend: () -> Void

	init(
		model: ChatComposerModel, config: MaskinComposerConfig, busy: Bool = false,
		onStop: (() -> Void)? = nil, onSend: @escaping () -> Void
	) {
		self.model = model
		self.config = config
		self.busy = busy
		self.onStop = onStop
		self.onSend = onSend
	}

	/// Design-review states that have no real trigger in a preview or a test.
	struct Preview {
		var dictating = false
		var trayOpen = false
		var dropTargeted = false
	}

	var preview: Preview?

	@FocusState private var focused: Bool
	@State private var trayOpen = false
	@State private var dropTargeted = false
	@State private var showPhotos = false
	@State private var showFiles = false
	@State private var photoItems: [PhotosPickerItem] = []
	@State private var dictating = false
	@State private var dictationBase = ""
	/// What went wrong with the microphone, shown once with a way to Settings.
	@State private var voiceProblem: String?
	#if os(iOS)
	@State private var dictation = Dictation()
	@State private var showCamera = false
	@Environment(\.openURL) private var openURL
	#endif
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	/// 40pt circles, each inside a 44pt hit frame.
	static let control: CGFloat = MaskinSpace.touchMin - MaskinSpace.s2
	private static let maxLines = 6
	private var shape: RoundedRectangle {
		RoundedRectangle(cornerRadius: MaskinRadius.composer, style: .continuous)
	}

	private var isDictating: Bool { preview?.dictating ?? dictating }
	private var isTrayOpen: Bool { preview?.trayOpen ?? trayOpen }
	private var isDropTargeted: Bool { preview?.dropTargeted ?? dropTargeted }

	var lastSlot: ComposerLastSlot {
		ComposerLastSlot.resolve(
			hasContent: model.hasContent, busy: busy && onStop != nil, showsMic: config.showsMic && micAvailable,
			showsSend: config.showsSend)
	}

	/// While Stop is showing the mic stays beside it, so dictation is never blocked by a busy agent.
	var showsMicBesideStop: Bool { lastSlot == .stop && config.showsMic && micAvailable }

	private var micAvailable: Bool {
		#if os(iOS)
		return true
		#else
		return preview != nil
		#endif
	}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			bar
			if let notice = model.notice {
				Text(notice).maskinText(.caption).foregroundStyle(MaskinColor.danger)
					.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, MaskinSpace.s5)
					.onTapGesture { model.notice = nil }
			}
		}
		.animation(MaskinMotion.quick, value: lastSlot)
		.animation(MaskinMotion.quick, value: isDictating)
		.animation(MaskinMotion.quick, value: model.attachments.map(\.id))
		.animation(MaskinMotion.quick, value: ComposerQuoteStrip.content(for: model)?.label)
		.onChange(of: model.focusRequest) { _, _ in focused = true }
		.onChange(of: model.text) { _, _ in if trayOpen { trayOpen = false } }
		.onChange(of: focused) { _, now in
			if now, trayOpen { trayOpen = false }
			config.onFocusChange?(now)
		}
		.onDisappear { trayOpen = false }
		.pickers(self)
		.voiceLifecycle(self)
	}

	// MARK: Bar

	private var bar: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			if let quote = ComposerQuoteStrip.content(for: model) {
				ComposerQuoteStrip(label: quote.label, text: quote.text, onClear: model.clearQuote)
					.padding(.top, MaskinSpace.s2)
					.transition(.opacity)
			}
			if !model.attachments.isEmpty || !model.mentions.isEmpty {
				ComposerChips(model: model)
					.padding(.top, MaskinSpace.s2)
					.transition(.opacity)
			}
			row
		}
		// Spec 7 §1: bar padding 6, gap 8.
		.padding(MaskinSpace.s3)
		.background { surface }
		.overlay {
			if isDropTargeted {
				shape.strokeBorder(
					MaskinColor.sig, style: StrokeStyle(lineWidth: MaskinSpace.s1, dash: [MaskinSpace.s3, MaskinSpace.s2]))
			}
		}
		.overlay(alignment: .top) { suggestionList }
		.overlay(alignment: .topLeading) { attachMenu }
		.animation(MaskinMotion.quick, value: isDropTargeted)
	}

	@ViewBuilder
	private var surface: some View {
		switch config.variant {
		case .floating:
			shape.fill(.clear)
				.maskinGlass(in: shape)
				.overlay(shape.strokeBorder(MaskinSurface.glassBorder, lineWidth: 0.5))
				.shadow(color: MaskinColor.overlayDim.opacity(0.35), radius: MaskinSpace.s10, y: MaskinSpace.s7)
		case .inline:
			shape.fill(MaskinSurface.cardInset)
				.overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
		}
	}

	private var row: some View {
		HStack(alignment: .bottom, spacing: MaskinSpace.s4) {
			// One field in one slot for both states. Moving it between branches makes SwiftUI build a
			// new field, which loses focus: the keyboard dropped and the thread jumped when dictation began.
			if isDictating {
				ComposerDictationLeading(onDiscard: discardDictation)
			} else if config.showsAttach {
				attachButton
			}
			field(placeholder: isDictating ? "Listening…" : config.placeholder)
			if isDictating {
				ComposerDictationDone(action: finishDictation)
			} else {
				if let goLive = config.goLive, !model.hasContent {
					ComposerCircleButton(
						symbol: "waveform", fill: MaskinSurface.fill, foreground: MaskinColor.ink2,
						label: "Start a live conversation", weight: .semibold
					) {
						MaskinHaptics.play(.medium)
						goLive()
					}
					.transition(.opacity)
				}
				lastSlotButton
			}
		}
	}

	// MARK: Field

	private func field(placeholder: String) -> some View {
		ComposerTextField(model: model, placeholder: placeholder, lines: 1...Self.maxLines, focused: $focused)
			.padding(.vertical, MaskinSpace.s4)
			.frame(minHeight: Self.control)
			.padding(.vertical, MaskinSpace.s1)
			.padding(.leading, config.showsAttach && !isDictating ? 0 : MaskinSpace.s5)
			.padding(.trailing, MaskinSpace.s1)
			.frame(maxWidth: .infinity)
	}

	// MARK: Last slot

	@ViewBuilder
	private var lastSlotButton: some View {
		ZStack {
			switch lastSlot {
			case .mic:
				micButton
			case .send:
				ComposerCircleButton(
					symbol: "arrow.up", fill: MaskinSurface.inverse, foreground: MaskinSurface.onInverse, label: "Send",
					weight: .heavy
				) {
					MaskinHaptics.play(.light)
					onSend()
					// Sent: drop the keyboard so the reply gets the whole window. Tapping the field brings it back.
					focused = false
				}
				.disabled(!model.canSend)
				.opacity(model.canSend ? 1 : 0.35)
				.accessibilityHint(model.sendBlocker ?? "")
				#if !os(watchOS) && !os(tvOS)
				.keyboardShortcut(.return, modifiers: .command)
				#endif
				.transition(.opacity)
			case .stop:
				HStack(spacing: 0) {
					// Stop must not take dictation away: the mic stays beside it while an agent works.
					if showsMicBesideStop { micButton }
					Button {
						MaskinHaptics.play(.selection)
						onStop?()
					} label: {
						RoundedRectangle(cornerRadius: MaskinRadius.tag2, style: .continuous)
							.fill(MaskinSurface.onInverse)
							.frame(width: MaskinSpace.s7, height: MaskinSpace.s7)
							.frame(width: Self.control, height: Self.control)
							.background(MaskinSurface.inverse, in: Circle())
							.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
							.contentShape(Circle())
					}
					.buttonStyle(.maskinPressed(.shrink))
					.accessibilityLabel("Stop")
					.transition(.opacity)
				}
			case .none:
				EmptyView()
			}
		}
	}

	private var micButton: some View {
		ComposerCircleButton(
			symbol: "mic", fill: MaskinSurface.fill, foreground: MaskinColor.ink3, label: "Dictate",
			weight: .regular
		) {
			MaskinHaptics.play(.selection)
			startDictation()
		}
		.transition(.opacity)
	}

	// MARK: Attach

	private var attachButton: some View {
		ComposerCircleButton(
			symbol: "plus", fill: MaskinSurface.fill, foreground: MaskinColor.ink3,
			label: isTrayOpen ? "Close attach menu" : "Attach", weight: .semibold,
			rotation: isTrayOpen ? 45 : 0
		) {
			MaskinHaptics.play(.selection)
			withAnimation(reduceMotion ? nil : MaskinMotion.standard) { trayOpen.toggle() }
		}
	}

	private var attachActions: [ComposerAttachAction] {
		var actions: [ComposerAttachAction] = [.photo]
		#if os(iOS)
		if CameraPicker.isAvailable { actions.append(.camera) }
		#endif
		actions += [.file, .object, .person]
		#if os(iOS)
		if UIPasteboard.general.hasImages { actions.append(.paste) }
		#endif
		return actions
	}

	@ViewBuilder
	private var attachMenu: some View {
		if isTrayOpen, !isDictating {
			ComposerAttachMenu(actions: attachActions, onPick: pick)
				.alignmentGuide(.top) { $0[.bottom] + MaskinSpace.s4 }
				.transition(.opacity.combined(with: .move(edge: .bottom)))
		}
	}

	private func pick(_ action: ComposerAttachAction) {
		withAnimation(reduceMotion ? nil : MaskinMotion.standard) { trayOpen = false }
		switch action {
		case .photo: showPhotos = true
		case .camera:
			#if os(iOS)
			showCamera = true
			#endif
		case .file: showFiles = true
		case .object:
			// No object search exists in the chat code yet; `/` is where it will hang (reported).
			insertTrigger("/")
		case .person: insertTrigger("@")
		case .paste:
			#if os(iOS)
			pasteImage()
			#endif
		}
	}

	private func insertTrigger(_ trigger: String) {
		let needsSpace = !(model.text.isEmpty || model.text.last?.isWhitespace == true)
		model.insert(needsSpace ? " \(trigger)" : trigger)
		focused = true
	}

	// MARK: Suggestions

	private func mentionCandidates(for query: String) -> [MentionPerson] {
		if let roster = config.roster {
			return roster.candidates(query: query, selfID: model.selfActorID, prioritizing: config.inConversation)
				.filter { person in !model.mentions.contains { $0.id == person.id } }
		}
		return config.suggestions(query).prefix(MentionRoster.maxRows).map {
			MentionPerson(id: $0.id, name: $0.name, kind: $0.kind)
		}
	}

	@ViewBuilder
	private var suggestionList: some View {
		if !isDictating, let match = MentionTrigger.find(in: model.text) {
			MentionSuggestions(
				people: mentionCandidates(for: match.query),
				onPick: { person in
					model.pick(person.mention)
					focused = true
				}
			)
			.alignmentGuide(.top) { $0[.bottom] + MaskinSpace.s4 }
			.transition(.opacity.combined(with: .move(edge: .bottom)))
		} else if let match = EmojiTrigger.find(in: model.text) {
			let found = EmojiShortcodes.suggestions(for: match.query, limit: 5)
			if !found.isEmpty {
				EmojiSuggestions(items: found) { model.pickEmoji($0.emoji) }
					.alignmentGuide(.top) { $0[.bottom] + MaskinSpace.s4 }
					.transition(.opacity.combined(with: .move(edge: .bottom)))
			}
		}
	}

	// MARK: Files

	fileprivate func addFiles(_ drops: [ComposerDrop]) {
		for drop in drops {
			switch drop {
			case .image(let data):
				let name = "Pasted image.jpg"
				model.attach(name: name, mimeType: "image/jpeg", prepare: AttachmentLoading.image(data: data, name: name))
			case .file(let url):
				model.attach(
					name: url.lastPathComponent, mimeType: AttachmentLoading.mimeType(for: url),
					prepare: AttachmentLoading.file(at: url, deleteAfter: true))
			}
		}
	}

	#if os(iOS)
	fileprivate func pasteImage() {
		guard let image = UIPasteboard.general.image, let data = image.jpegData(compressionQuality: 0.9) else { return }
		addFiles([.image(data)])
	}

	fileprivate func addPhoto(_ data: Data) {
		let name = AttachmentLoading.photoName(index: 0)
		model.attach(name: name, mimeType: "image/jpeg", prepare: AttachmentLoading.image(data: data, name: name))
	}
	#endif

	// MARK: Dictation

	private func startDictation() {
		#if os(iOS)
		guard !dictation.isListening else { return }
		dictationBase = model.text
		trayOpen = false
		Task {
			await dictation.start(continuous: true, backend: true) { model.text = DictationText.merge(base: dictationBase, transcript: $0) }
			if case .unavailable(let message) = dictation.state {
				voiceProblem = message
				dictation.clearError()
			}
			dictating = dictation.isListening
		}
		#else
		dictationBase = model.text
		dictating = true
		#endif
	}

	private func finishDictation() {
		#if os(iOS)
		// Through the server the last phrase is still being transcribed: keep the dictation bar up
		// until its text is in, so the keyboard doesn't take over mid-word.
		if dictation.usesBackend {
			Task {
				await dictation.finish()
				dictating = false
				focused = true
			}
			return
		}
		dictation.stop()
		#endif
		dictating = false
		focused = true
	}

	private func discardDictation() {
		#if os(iOS)
		dictation.stop()
		#endif
		model.text = dictationBase
		dictating = false
	}

	// MARK: Lifecycle

	/// Pickers and the drop/paste targets, kept off `body` so the bar reads top to bottom.
	fileprivate struct Pickers: ViewModifier {
		let composer: MaskinComposer

		func body(content: Content) -> some View {
			let base =
				content
				.photosPicker(
					isPresented: composer.$showPhotos, selection: composer.$photoItems,
					maxSelectionCount: max(1, ChatLimits.maxAttachments - composer.model.attachments.count),
					matching: .any(of: [.images, .videos]))
				.fileImporter(
					isPresented: composer.$showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true
				) { result in
					guard case .success(let urls) = result else { return }
					for url in urls {
						composer.model.attach(
							name: url.lastPathComponent, mimeType: AttachmentLoading.mimeType(for: url),
							prepare: AttachmentLoading.file(at: url))
					}
				}
				.onChange(of: composer.photoItems) { _, items in
					guard !items.isEmpty else { return }
					for (index, item) in items.enumerated() {
						let name = AttachmentLoading.photoName(index: index)
						composer.model.attach(
							name: name, mimeType: AttachmentLoading.isMovie(item) ? "video/quicktime" : "image/jpeg",
							prepare: AttachmentLoading.media(item, name: name))
					}
					composer.photoItems = []
				}
			// Drop works on iPad and Mac. `pasteDestination` is Mac-only; on iPhone an image is pasted
			// through the `+` menu's "Paste image" row, which appears while the clipboard holds one.
			#if os(macOS)
			base
				.dropDestination(for: ComposerDrop.self) { items, _ in
					composer.addFiles(items)
					return !items.isEmpty
				} isTargeted: { composer.dropTargeted = $0 }
				.pasteDestination(for: ComposerDrop.self) { composer.addFiles($0) }
			#elseif os(iOS)
			base
				.dropDestination(for: ComposerDrop.self) { items, _ in
					composer.addFiles(items)
					return !items.isEmpty
				} isTargeted: { composer.dropTargeted = $0 }
			#else
			base
			#endif
		}
	}

	/// Stops the mic when the composer goes away, ends dictation that stopped by itself, shows the
	/// camera, and explains a microphone failure.
	fileprivate struct VoiceLifecycle: ViewModifier {
		let composer: MaskinComposer

		func body(content: Content) -> some View {
			#if os(iOS)
			content
				.onDisappear { composer.dictation.stop() }
				.onChange(of: composer.dictation.isListening) { _, listening in
					if !listening, composer.dictating { composer.dictating = false }
				}
				.onChange(of: composer.dictation.state) { _, state in
					guard case .unavailable(let message) = state else { return }
					composer.dictation.clearError()
					composer.voiceProblem = message
				}
				.fullScreenCover(isPresented: composer.$showCamera) {
					CameraPicker { composer.addPhoto($0) }.ignoresSafeArea()
				}
				.alert(
					"Microphone", isPresented: Binding(get: { composer.voiceProblem != nil }, set: { if !$0 { composer.voiceProblem = nil } })
				) {
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
}

extension MaskinComposer {
	/// Show a state that has no real trigger here (dictating, the `+` menu open, a drag over the bar).
	func composerPreview(_ preview: Preview?) -> MaskinComposer {
		var copy = self
		copy.preview = preview
		return copy
	}
}

private extension View {
	func pickers(_ composer: MaskinComposer) -> some View { modifier(MaskinComposer.Pickers(composer: composer)) }
	func voiceLifecycle(_ composer: MaskinComposer) -> some View {
		modifier(MaskinComposer.VoiceLifecycle(composer: composer))
	}
}

/// A 40pt circle with a 44pt hit area: `+`, mic, Go live, Send, discard and done.
struct ComposerCircleButton: View {
	let symbol: String
	let fill: Color
	let foreground: Color
	let label: String
	var weight: Font.Weight = .semibold
	var rotation: Double = 0
	let action: () -> Void

	init(
		symbol: String, fill: Color, foreground: Color, label: String, weight: Font.Weight = .semibold,
		rotation: Double = 0, action: @escaping () -> Void
	) {
		self.symbol = symbol
		self.fill = fill
		self.foreground = foreground
		self.label = label
		self.weight = weight
		self.rotation = rotation
		self.action = action
	}

	var body: some View {
		Button(action: action) {
			Image(systemName: symbol)
				.maskinSymbol(MaskinFontSize.t17, weight: weight)
				.foregroundStyle(foreground)
				.rotationEffect(.degrees(rotation))
				.frame(width: MaskinComposer.control, height: MaskinComposer.control)
				.background(fill, in: Circle())
				.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
				.contentShape(Circle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel(label)
	}
}

/// The message field: 16pt regular, grows to six lines then scrolls, Return inserts a newline.
/// From iOS 18 it reports the selection so a format wraps the chosen words; before that a format
/// acts at the end of the text.
struct ComposerTextField: View {
	@Bindable var model: ChatComposerModel
	let placeholder: String
	var lines: ClosedRange<Int> = 1...6
	var focused: FocusState<Bool>.Binding

	var body: some View {
		Group {
			if #available(iOS 18, macOS 15, *) {
				SelectionTextField(model: model, placeholder: placeholder, lines: lines, focused: focused)
			} else {
				TextField(text: $model.text, prompt: prompt, axis: .vertical) { Text("Message") }
					.lineLimit(lines)
					.focused(focused)
			}
		}
		.textFieldStyle(.plain)
		.font(MaskinTypeface.sans(MaskinFontSize.t16, relativeTo: .body))
		.foregroundStyle(MaskinColor.ink)
		.accessibilityLabel(placeholder)
	}

	var prompt: Text { Text(placeholder).foregroundStyle(MaskinColor.ink5) }
}

@available(iOS 18, macOS 15, *)
private struct SelectionTextField: View {
	@Bindable var model: ChatComposerModel
	let placeholder: String
	let lines: ClosedRange<Int>
	var focused: FocusState<Bool>.Binding
	@State private var selection: TextSelection?

	var body: some View {
		TextField(text: $model.text, selection: $selection, prompt: Text(placeholder).foregroundStyle(MaskinColor.ink5), axis: .vertical) {
			Text("Message")
		}
		.lineLimit(lines)
		.focused(focused)
		.onChange(of: selection) { _, new in model.selection = offsets(of: new) }
		.onChange(of: model.selectionRequest) { _, request in
			guard let request else { return }
			selection = textSelection(for: request.range)
		}
	}

	private func offsets(of selection: TextSelection?) -> Range<Int>? {
		guard let selection, case .selection(let range) = selection.indices else { return nil }
		// Not String.distance directly: the selection can hold indices from an older text (cleared
		// after a send, replaced by a draft or dictation) and distance traps on those.
		return TextOffsets.characterOffsets(of: range, in: model.text)
	}

	private func textSelection(for range: Range<Int>) -> TextSelection {
		let text = model.text
		let lower = text.index(text.startIndex, offsetBy: min(range.lowerBound, text.count))
		let upper = text.index(text.startIndex, offsetBy: min(range.upperBound, text.count))
		return TextSelection(range: lower..<upper)
	}
}

// MARK: - Previews

#Preview("Composer gallery — light") { MaskinComposerGallery().preferredColorScheme(.light) }
#Preview("Composer gallery — dark") { MaskinComposerGallery().preferredColorScheme(.dark) }

/// Every state the composer takes, on one screen, for design review.
struct MaskinComposerGallery: View {
	private struct Stub: ChatFileUploading {
		func upload(name: String, mimeType: String, data: Data) async throws -> ChatAttachmentRef {
			ChatAttachmentRef(fileID: UUID().uuidString, name: name, mimeType: mimeType, sizeBytes: data.count)
		}
	}

	@State private var empty = ChatComposerModel(uploader: nil, selfActorID: "me")
	@State private var typed = ChatComposerModel(uploader: nil, selfActorID: "me")
	@State private var quoted = ChatComposerModel(uploader: nil, selfActorID: "me")
	@State private var editing = ChatComposerModel(uploader: nil, selfActorID: "me")
	@State private var attached = ChatComposerModel(uploader: Stub(), selfActorID: "me")
	@State private var hold = ChatComposerModel(uploader: nil, selfActorID: "me")

	private let people = [ChatParticipant(id: "forge", name: "Forge", kind: .agent), ChatParticipant(id: "sam", name: "Sam Berg", kind: .human)]

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s12) {
				section("Floating, empty") {
					MaskinComposer(model: empty, config: .init(placeholder: "Message Forge"), onSend: {})
				}
				section("Floating, with text") {
					MaskinComposer(model: typed, config: .init(placeholder: "Message Forge"), onSend: {})
				}
				section("Busy → Stop") {
					MaskinComposer(model: empty, config: .init(placeholder: "Message Forge"), busy: true, onStop: {}, onSend: {})
				}
				section("Team room → Go live") {
					MaskinComposer(model: empty, config: .init(placeholder: "Message the team", showsMic: false, goLive: {}), onSend: {})
				}
				section("Dictating") {
					MaskinComposer(model: typed, config: .init(placeholder: "Message Forge"), onSend: {})
						.composerPreview(.init(dictating: true))
				}
				section("Replying") {
					MaskinComposer(model: quoted, config: .init(placeholder: "Message Forge"), onSend: {})
				}
				section("Editing") {
					MaskinComposer(model: editing, config: .init(placeholder: "Message Forge"), onSend: {})
				}
				section("Attachments") {
					MaskinComposer(model: attached, config: .init(placeholder: "Message Forge"), onSend: {})
				}
				section("Inline (thread reply)") {
					MaskinComposer(model: empty, config: .init(variant: .inline, placeholder: "Reply in thread"), onSend: {})
				}
				section("Hold reason (inline, no send)") {
					MaskinComposer(
						model: hold, config: .init(variant: .inline, placeholder: "Why hold this?", showsAttach: false, showsSend: false),
						onSend: {})
				}
				section("Attach menu open") {
					MaskinComposer(model: empty, config: .init(placeholder: "Message Forge"), onSend: {})
						.composerPreview(.init(trayOpen: true))
						.padding(.top, 300)
				}
				section("@mention popover") {
					MaskinComposer(
						model: typed, config: .init(placeholder: "Message Forge", suggestions: { _ in people }, inConversation: ["forge"]),
						onSend: {}
					)
					.padding(.top, 120)
				}
			}
			.padding(MaskinSpace.s9)
		}
		.background(MaskinSurface.grouped)
		.task {
			typed.text = "Sounds good, send me the draft when it is ready and flag anything risky."
			quoted.reply(to: "Forge", text: "The importer fix shipped this morning; two insights still need a decision.")
			editing.beginEdit(messageID: "12", originalText: "Yes please, and flag anything risky.")
			attached.text = "Here is the brief"
			attached.attach(name: "Q3 pipeline.pdf", mimeType: "application/pdf") {
				PreparedChatFile(name: "Q3 pipeline.pdf", mimeType: "application/pdf", data: Data(count: 2_000))
			}
			hold.text = "Waiting on legal"
		}
	}

	private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			Text(title).maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
			content()
		}
	}
}
