import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// How the thread gets the pictures attached to messages. Supplied by the app root, which owns the
/// file client; absent in previews and tests, where photos fall back to a file chip.
struct AttachmentImages: Sendable {
	/// The thumbnail if it is already in memory. Never waits.
	var cached: @Sendable (String) -> DecodedImage?
	/// Fetches (once) and decodes the thumbnail; nil when it can't be loaded.
	var load: @Sendable (String) async -> DecodedImage?
}

extension EnvironmentValues {
	@Entry var attachmentImages: AttachmentImages? = nil
	/// Opens an attached file in the app, by file id.
	@Entry var openAttachment: (@MainActor (String) -> Void)? = nil
}

extension ChatAttachmentRef {
	var isImage: Bool { (mimeType ?? "").lowercased().hasPrefix("image/") }
}

/// A photo in a message. One photo is shown large; several are shown as square tiles. Tapping
/// opens the file. While it loads there is a placeholder; if it can't load, a file chip stands in.
struct AttachmentThumbnail: View {
	enum Style { case large, tile }

	let file: ChatAttachmentRef
	var style: Style = .large
	@Environment(\.attachmentImages) private var images
	@Environment(\.openAttachment) private var open
	@State private var loaded: DecodedImage?
	@State private var failed = false

	private static let largeMax = CGSize(width: 280, height: 320)
	private static let tileSide: CGFloat = 108

	var body: some View {
		let image = loaded ?? images?.cached(file.fileID)
		Group {
			if let image {
				Button { open?(file.fileID) } label: { picture(image) }
					.buttonStyle(.plain)
					.accessibilityLabel("Photo \(file.name ?? "")")
					.accessibilityHint("Opens the file")
			} else if failed || images == nil {
				MessageFileChip(file: file)
			} else {
				placeholder
			}
		}
		.task(id: file.fileID) {
			guard loaded == nil, let images, images.cached(file.fileID) == nil else { return }
			failed = false
			loaded = await images.load(file.fileID)
			failed = loaded == nil
		}
	}

	@ViewBuilder
	private func picture(_ image: DecodedImage) -> some View {
		let shape = RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
		let view = Image(decorative: image.cgImage, scale: 3).resizable()
		switch style {
		case .large:
			// Sized from the picture's own proportions, so the box hugs it (a flexible frame would
			// grow to its maximum) and nothing shifts when it replaces the placeholder.
			let ratio = CGFloat(image.cgImage.width) / CGFloat(max(image.cgImage.height, 1))
			let width = min(Self.largeMax.width, Self.largeMax.height * ratio)
			view.frame(width: width, height: width / ratio)
				.clipShape(shape).overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
		case .tile:
			view.scaledToFill()
				.frame(width: Self.tileSide, height: Self.tileSide)
				.clipShape(shape).overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
		}
	}

	private var placeholder: some View {
		let shape = RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
		let size = style == .tile ? CGSize(width: Self.tileSide, height: Self.tileSide) : CGSize(width: 220, height: 160)
		return shape.fill(MaskinSurface.fill)
			.frame(width: size.width, height: size.height)
			.overlay { ProgressView().controlSize(.small) }
			.accessibilityLabel("Loading photo")
	}
}

/// A file a message cites: name and size, tappable to open it.
struct MessageFileChip: View {
	let file: ChatAttachmentRef
	@Environment(\.openAttachment) private var open

	var body: some View {
		Button { open?(file.fileID) } label: {
			HStack(spacing: MaskinSpace.s3) {
				Image(systemName: file.isImage ? "photo" : "doc")
					.foregroundStyle(MaskinColor.ink3).accessibilityHidden(true)
				Text(file.name ?? "Attachment").maskinText(.caption).foregroundStyle(MaskinColor.ink)
					.lineLimit(1).truncationMode(.middle)
				if let size = ChatByteFormat.string(file.sizeBytes) {
					Text(size).maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
				}
			}
			.padding(.horizontal, MaskinSpace.s5)
			.frame(minHeight: MaskinSpace.s12 + MaskinSpace.s4, alignment: .leading)
			.frame(maxWidth: 260, alignment: .leading)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous)
					.strokeBorder(MaskinSurface.line, lineWidth: 1))
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel("Attachment \(file.name ?? "file")")
		.accessibilityHint("Opens the file")
	}
}
