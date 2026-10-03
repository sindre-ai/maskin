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
			Divider().overlay(MaskinSurface.separator)
			switch model.phase {
			case .loading:
				ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
			case .blocked(let error):
				blocked(error)
			case .posted:
				posted
			case .ready, .posting, .failed:
				form
			}
		}
		.background(MaskinSurface.grouped.ignoresSafeArea())
		.task { await model.start() }
		.onChange(of: model.phase) { _, phase in
			if case .posted = phase { MaskinHaptics.play(.success) }
			if case .failed = phase { MaskinHaptics.play(.error) }
		}
	}

	// MARK: Header

	private var header: some View {
		HStack(spacing: MaskinSpace.s5) {
			Text("M")
				.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .bold))
				.foregroundStyle(MaskinSurface.onInverse)
				.frame(width: 30, height: 30)
				.background(MaskinSurface.inverse, in: RoundedRectangle(cornerRadius: MaskinRadius.cardLg, style: .continuous))
				.accessibilityHidden(true)
			Text("Send to Maskin")
				.maskinText(.headline)
				.foregroundStyle(MaskinColor.ink)
				.accessibilityAddTraits(.isHeader)
			Spacer(minLength: MaskinSpace.s4)
			Button(isPosted ? "Done" : "Cancel", action: onClose)
				.maskinText(.headline)
				.foregroundStyle(MaskinColor.accent)
				.frame(minHeight: MaskinSpace.touchMin)
				.disabled(isPosting)
		}
		.padding(.horizontal, MaskinSpace.s10)
		.padding(.top, MaskinSpace.s4)
	}

	private var isPosting: Bool { if case .posting = model.phase { true } else { false } }
	private var isPosted: Bool { if case .posted = model.phase { true } else { false } }

	// MARK: Form

	private var form: some View {
		VStack(spacing: 0) {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s8) {
					SharePreviewCard(content: model.content)
					if model.showsTitleField { titleField }
					destinationPicker
					workspaceRow
					noteField
					ForEach(model.content.skipped.indices, id: \.self) { index in
						Label(model.content.skipped[index].message, systemImage: "exclamationmark.circle")
							.maskinText(.caption)
							.foregroundStyle(MaskinColor.ink4)
					}
				}
				.padding(MaskinSpace.s10)
			}
			.scrollDismissesKeyboard(.interactively)
			footer
		}
	}

	private var titleField: some View {
		TextField("Title", text: $model.title, axis: .vertical)
			.lineLimit(1...3)
			.maskinText(.body)
			.foregroundStyle(MaskinColor.ink)
			.padding(MaskinSpace.s9)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
			.accessibilityLabel("Title")
			.disabled(isPosting)
	}

	private var destinationPicker: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			MonoLabel("Save as")
			ScrollView(.horizontal, showsIndicators: false) {
				HStack(spacing: MaskinSpace.s4) {
					ForEach(model.typeOptions, id: \.self) { option in
						let selected = option == model.destination
						Button {
							model.destination = option
							MaskinHaptics.play(.selection)
						} label: {
							Text(model.label(for: option))
								.maskinText(.subhead)
								.fontWeight(.semibold)
								.foregroundStyle(selected ? MaskinSurface.onInverse : MaskinColor.ink)
								.padding(.horizontal, MaskinSpace.s9)
								.frame(minHeight: MaskinSpace.touchMin)
								.background(
									selected ? MaskinSurface.inverse : MaskinSurface.card,
									in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
						}
						.buttonStyle(.plain)
						.accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
						.disabled(isPosting)
					}
				}
			}
			.scrollClipDisabled()
		}
	}

	@ViewBuilder private var workspaceRow: some View {
		if let name = model.workspace?.name {
			HStack {
				Text("Workspace").maskinText(.body).foregroundStyle(MaskinColor.ink)
				Spacer(minLength: MaskinSpace.s4)
				Text(name).maskinText(.body).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			}
			.padding(.horizontal, MaskinSpace.s9)
			.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s3)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
			.accessibilityElement(children: .combine)
		}
	}

	private var noteField: some View {
		TextField("Add a note: what you want done with this", text: $model.note, axis: .vertical)
			.lineLimit(3...6)
			.focused($noteFocused)
			.maskinText(.body)
			.foregroundStyle(MaskinColor.ink)
			.padding(MaskinSpace.s9)
			.frame(maxWidth: .infinity, minHeight: 88, alignment: .topLeading)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
			.accessibilityLabel("Note")
			.disabled(isPosting)
	}

	// MARK: Footer

	private var footer: some View {
		VStack(spacing: MaskinSpace.s5) {
			if case .failed(let error) = model.phase {
				FormError(error.message)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
			Button {
				noteFocused = false
				Task { await model.post() }
			} label: {
				HStack(spacing: MaskinSpace.s4) {
					if isPosting { ProgressView().tint(MaskinSurface.onInverse) }
					Text(actionTitle)
				}
			}
			.buttonStyle(.primaryAction)
			.disabled(!model.canPost)
			.accessibilityHint(isPosting ? "Sending" : "")
		}
		.padding(.horizontal, MaskinSpace.s10)
		.padding(.top, MaskinSpace.s5)
		.padding(.bottom, MaskinSpace.s9)
		.background(MaskinSurface.grouped)
	}

	private var actionTitle: String {
		switch model.phase {
		case .posting(let step):
			if case .uploading(let index, let total)? = step, total > 1 { return "Uploading \(index) of \(total)" }
			return "Sending"
		case .failed(let error): return error.isRetryable ? "Try again" : "Send to Maskin"
		default: return "Send to Maskin"
		}
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
				ShareThumbnail(url: image.fileURL).frame(width: 64, height: 64)
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
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1)
		)
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
