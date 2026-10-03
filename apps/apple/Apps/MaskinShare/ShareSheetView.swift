import ImageIO
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The share sheet. Pure SwiftUI over `ShareSheetModel`; the view controller supplies the host
/// integration (closing, opening the app) as closures, so this file renders in previews and
/// snapshot tests without an extension context.
struct ShareSheetView: View {
	@Bindable var model: ShareSheetModel
	var onClose: () -> Void
	var onOpen: (URL) -> Void

	@FocusState private var noteFocused: Bool

	var body: some View {
		VStack(spacing: 0) {
			header
			switch model.phase {
			case .loading:
				ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
			case .blocked(let error):
				blocked(error)
			case .posted:
				posted
			case .queued:
				queued
			case .ready, .posting, .failed:
				form
			}
		}
		.background(MaskinSurface.grouped.ignoresSafeArea())
		.task { await model.start() }
		.onChange(of: model.phase) { _, phase in
			switch phase {
			case .posted, .queued: MaskinHaptics.play(.success)
			case .failed: MaskinHaptics.play(.error)
			default: break
			}
		}
	}

	// MARK: Header

	/// Just the way out: the sheet is a composer, not a form, so there is no title bar to read.
	private var header: some View {
		HStack {
			Button(isDone ? "Done" : "Cancel", action: onClose)
				.maskinText(.headline)
				.foregroundStyle(MaskinColor.ink3)
				.frame(minHeight: MaskinSpace.touchMin)
				.disabled(isPosting)
			Spacer(minLength: MaskinSpace.s4)
		}
		.padding(.horizontal, MaskinSpace.s10)
		.padding(.top, MaskinSpace.s2)
	}

	private var isPosting: Bool { if case .posting = model.phase { true } else { false } }
	private var isDone: Bool {
		switch model.phase {
		case .posted, .queued: true
		default: false
		}
	}

	// MARK: Composer

	private var form: some View {
		VStack(spacing: MaskinSpace.s6) {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s6) {
					composer
					ForEach(model.content.skipped.indices, id: \.self) { index in
						Label(model.content.skipped[index].message, systemImage: "exclamationmark.circle")
							.maskinText(.caption)
							.foregroundStyle(MaskinColor.ink4)
							.padding(.horizontal, MaskinSpace.s4)
					}
					if case .failed(let error) = model.phase {
						FormError(error.message).frame(maxWidth: .infinity, alignment: .leading)
					}
				}
				.padding(.horizontal, MaskinSpace.s10)
			}
			.scrollDismissesKeyboard(.interactively)
		}
		.padding(.bottom, MaskinSpace.s6)
	}

	/// One big rounded surface holding everything: what is shared, the note, and a toolbar row
	/// with where it goes and the send button.
	private var composer: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			SharePreviewCard(content: model.content)
			if model.showsTitleField {
				TextField("Title", text: $model.title, axis: .vertical)
					.lineLimit(1...3)
					.maskinText(.headline)
					.foregroundStyle(MaskinColor.ink)
					.accessibilityLabel("Title")
					.disabled(isPosting)
			}
			TextField(model.isChat ? "Add a message" : "Add a note: what you want done with this", text: $model.note, axis: .vertical)
				.lineLimit(3...8)
				.focused($noteFocused)
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink)
				.frame(maxWidth: .infinity, minHeight: 72, alignment: .topLeading)
				.accessibilityLabel(model.isChat ? "Message" : "Note")
				.disabled(isPosting)
			toolbar
		}
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
	}

	private var toolbar: some View {
		HStack(spacing: MaskinSpace.s4) {
			destinationMenu
			workspaceMenu
			Spacer(minLength: MaskinSpace.s4)
			sendButton
		}
	}

	private func pill(_ title: String, systemImage: String) -> some View {
		HStack(spacing: MaskinSpace.s2) {
			Image(systemName: systemImage).imageScale(.small)
			Text(title).lineLimit(1)
			Image(systemName: "chevron.up.chevron.down").imageScale(.small).foregroundStyle(MaskinColor.ink4)
		}
		.maskinText(.subhead)
		.fontWeight(.semibold)
		.foregroundStyle(MaskinColor.ink2)
		.padding(.horizontal, MaskinSpace.s7)
		.frame(minHeight: MaskinSpace.touchMin)
		.background(MaskinSurface.cardInset2, in: Capsule())
		.contentShape(Capsule())
	}

	private var destinationMenu: some View {
		Menu {
			Section("Save as") {
				ForEach(model.typeOptions.filter { !isChat($0) }, id: \.self) { option in
					Button(model.label(for: option)) { select(option) }
				}
			}
			if !model.conversations.isEmpty {
				Section("Send to chat") {
					ForEach(model.conversations) { conversation in
						Button(conversation.title) { select(.chat(id: conversation.id)) }
					}
				}
			}
		} label: {
			pill(model.label(for: model.destination), systemImage: model.isChat ? "bubble.left" : "square.and.pencil")
		}
		.disabled(isPosting)
		.accessibilityLabel("Destination: \(model.label(for: model.destination))")
	}

	@ViewBuilder private var workspaceMenu: some View {
		if model.workspaces.count > 1, let name = model.workspace?.name {
			Menu {
				ForEach(model.workspaces, id: \.id) { workspace in
					Button {
						Task { await model.selectWorkspace(workspace.id) }
					} label: {
						if workspace.id == model.activeWorkspaceId {
							Label(workspace.name, systemImage: "checkmark")
						} else {
							Text(workspace.name)
						}
					}
				}
			} label: {
				pill(name, systemImage: "square.grid.2x2")
			}
			.disabled(isPosting)
			.accessibilityLabel("Workspace: \(name)")
		} else if let name = model.workspace?.name {
			Text(name)
				.maskinText(.subhead)
				.foregroundStyle(MaskinColor.ink4)
				.lineLimit(1)
		}
	}

	/// The round send arrow. Disabled and spinner-bearing while a post is in flight; the failed
	/// state keeps it enabled so it doubles as Try again.
	private var sendButton: some View {
		Button {
			noteFocused = false
			Task { await model.post() }
		} label: {
			ZStack {
				if isPosting {
					ProgressView().tint(MaskinSurface.onInverse)
				} else {
					Image(systemName: failedRetry ? "arrow.clockwise" : "arrow.up")
						.font(.system(size: 17, weight: .bold))
						.foregroundStyle(MaskinSurface.onInverse)
				}
			}
			.frame(width: 44, height: 44)
			.background(MaskinSurface.inverse, in: Circle())
			.opacity(model.canPost || isPosting ? 1 : 0.4)
		}
		.buttonStyle(.plain)
		.disabled(!model.canPost)
		.accessibilityLabel(sendLabel)
	}

	private var failedRetry: Bool {
		if case .failed(let error) = model.phase { error.isRetryable } else { false }
	}

	private var sendLabel: String {
		switch model.phase {
		case .posting(let step):
			if case .uploading(let index, let total)? = step, total > 1 { return "Uploading \(index) of \(total)" }
			return "Sending"
		case .failed(let error): return error.isRetryable ? "Try again" : "Send to Maskin"
		default: return "Send to Maskin"
		}
	}

	private func isChat(_ destination: ShareDestination) -> Bool {
		if case .chat = destination { true } else { false }
	}

	private func select(_ destination: ShareDestination) {
		model.destination = destination
		MaskinHaptics.play(.selection)
	}

	// MARK: Terminal states

	private var posted: some View {
		VStack(spacing: MaskinSpace.s11) {
			Spacer()
			Image(systemName: "checkmark.circle.fill")
				.font(.system(size: 56))
				.foregroundStyle(MaskinColor.success)
				.accessibilityHidden(true)
			VStack(spacing: MaskinSpace.s3) {
				Text("Sent to Maskin").maskinText(.title).foregroundStyle(MaskinColor.ink)
				if let name = model.workspace?.name {
					Text(name).maskinText(.body).foregroundStyle(MaskinColor.ink4)
				}
			}
			.multilineTextAlignment(.center)
			Spacer()
			VStack(spacing: MaskinSpace.s5) {
				if let url = model.openURL {
					Button("Open in Maskin") { onOpen(url) }.buttonStyle(.primaryAction)
				}
				Button("Done", action: onClose).buttonStyle(.secondaryAction)
			}
			.padding(.horizontal, MaskinSpace.s10)
			.padding(.bottom, MaskinSpace.s9)
		}
		.accessibilityElement(children: .contain)
	}

	private var queued: some View {
		VStack(spacing: MaskinSpace.s11) {
			Spacer()
			Image(systemName: "clock.arrow.circlepath")
				.font(.system(size: 56))
				.foregroundStyle(MaskinColor.ink3)
				.accessibilityHidden(true)
			VStack(spacing: MaskinSpace.s3) {
				Text("Saved for later").maskinText(.title).foregroundStyle(MaskinColor.ink)
				Text("Maskin will send it next time you open the app with a connection.")
					.maskinText(.body).foregroundStyle(MaskinColor.ink4)
			}
			.multilineTextAlignment(.center)
			.padding(.horizontal, MaskinSpace.s12)
			Spacer()
			Button("Done", action: onClose)
				.buttonStyle(.primaryAction)
				.padding(.horizontal, MaskinSpace.s10)
				.padding(.bottom, MaskinSpace.s9)
		}
	}

	private func blocked(_ error: ShareError) -> some View {
		VStack(spacing: MaskinSpace.s11) {
			Spacer()
			Image(systemName: error.needsApp ? "person.crop.circle.badge.exclamationmark" : "tray")
				.font(.system(size: 44))
				.foregroundStyle(MaskinColor.ink4)
				.accessibilityHidden(true)
			Text(error.message)
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink2)
				.multilineTextAlignment(.center)
				.padding(.horizontal, MaskinSpace.s12)
			Spacer()
			VStack(spacing: MaskinSpace.s5) {
				if error.needsApp, let url = URL(string: "maskin://open") {
					Button("Open Maskin") { onOpen(url) }.buttonStyle(.primaryAction)
				}
				Button("Close", action: onClose).buttonStyle(.secondaryAction)
			}
			.padding(.horizontal, MaskinSpace.s10)
			.padding(.bottom, MaskinSpace.s9)
		}
	}
}

// MARK: - Preview card

/// What is being shared: kind label, a thumbnail for an image, the headline and one detail line.
struct SharePreviewCard: View {
	let content: ShareContent

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s8) {
			if let image = content.attachments.first(where: { $0.kind == .image }) {
				ShareThumbnail(url: image.fileURL).frame(width: 52, height: 52)
			}
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				MonoLabel(kindLabel)
				Text(headline)
					.maskinText(.headline)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(3)
				if let detail {
					Text(detail)
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.ink4)
						.lineLimit(3)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.padding(MaskinSpace.s7)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.cardInset2, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
		.accessibilityElement(children: .combine)
	}

	private var kindLabel: String {
		let files = content.attachments
		if files.count > 1 { return "\(files.count) FILES" }
		switch files.first?.kind {
		case .image?: return "IMAGE"
		case .pdf?: return "PDF"
		case .file?: return "FILE"
		case nil: return content.link != nil ? "LINK" : "TEXT"
		}
	}

	private var headline: String {
		let suggested = content.suggestedTitle
		return suggested.isEmpty ? "Shared item" : suggested
	}

	private var detail: String? {
		if let link = content.link {
			return content.linkTitle == nil ? nil : link.host ?? link.absoluteString
		}
		if let first = content.attachments.first {
			let size = ByteCountFormatter.string(fromByteCount: Int64(first.sizeBytes), countStyle: .file)
			return content.attachments.count > 1 ? first.name : "\(first.name) · \(size)"
		}
		if let text = content.text, text.contains("\n") || text.count > headline.count {
			return text
		}
		return nil
	}
}

/// A small, downsampled preview: ImageIO decodes straight to the thumbnail size.
struct ShareThumbnail: View {
	let url: URL
	@State private var image: CGImage?

	var body: some View {
		ZStack {
			MaskinSurface.cardInset2
			if let image {
				Image(decorative: image, scale: 2).resizable().scaledToFill()
			}
		}
		.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.cardLg, style: .continuous))
		.task(id: url) {
			image = await Task.detached(priority: .utility) { Self.thumbnail(url) }.value
		}
		.accessibilityHidden(true)
	}

	nonisolated static func thumbnail(_ url: URL) -> CGImage? {
		guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary)
		else { return nil }
		return CGImageSourceCreateThumbnailAtIndex(
			source, 0,
			[
				kCGImageSourceCreateThumbnailFromImageAlways: true,
				kCGImageSourceCreateThumbnailWithTransform: true,
				kCGImageSourceThumbnailMaxPixelSize: 160,
			] as CFDictionary)
	}
}
