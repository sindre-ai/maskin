import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Where an attachment stands on its way to the chat. A message that is still sending shows its
/// pictures and files as uploading; one that failed shows them with Retry.
enum AttachmentTransfer: Equatable {
	case ready
	/// 0...1 when the upload reports it, nil while it only knows it is under way.
	case uploading(progress: Double?)
	case failed
}

/// The sizes of the picture block and its tiles. Pure, so the grids can be tested without a view.
enum AttachmentLayout {
	/// Both blocks stop at 320pt; on a phone the pictures take 80% of the thread and the files 92%.
	static let maxWidth: CGFloat = 320
	static let imageFraction: CGFloat = 0.8
	static let fileFraction: CGFloat = 0.92
	/// Between blocks, between tiles and between file cards.
	static let gap = MaskinSpace.s2
	static let blockRadius = MaskinRadius.cardXl
	static let tileRadius = MaskinRadius.btn
	/// The grid shows four tiles; the rest is a +N on the fourth.
	static let maxTiles = 4

	/// The block's width in a thread `thread` wide. Unknown (0) before the row is measured.
	static func width(thread: CGFloat, fraction: CGFloat) -> CGFloat {
		thread > 0 ? min(maxWidth, thread * fraction) : maxWidth
	}

	static func overflow(_ count: Int) -> Int { max(0, count - maxTiles) }

	/// One picture keeps its shape between 3:4 portrait and 4:3 landscape. Anchored on the design:
	/// 240 wide for the tallest, 260 for a square, the full width for the widest (at 320).
	static func singleSize(ratio: CGFloat, width: CGFloat) -> CGSize {
		let r = min(max(ratio, 3.0 / 4.0), 4.0 / 3.0)
		let factor =
			r <= 1
			? 0.75 + (r - 0.75) / 0.25 * (0.8125 - 0.75)
			: 0.8125 + (r - 1) / (1.0 / 3.0) * (1 - 0.8125)
		let w = (width * factor).rounded()
		return CGSize(width: w, height: (w / r).rounded())
	}

	/// 2 pictures side by side (2:1), 3 with one large on the left and two stacked (4:3), 4 or more
	/// as 2 by 2 (square). The frames are inside a block of `blockSize(count:width:)`.
	static func tileFrames(count: Int, width: CGFloat) -> [CGRect] {
		let half = ((width - gap) / 2).rounded(.down)
		let far = width - half
		switch min(count, maxTiles) {
		case ...1:
			return [CGRect(x: 0, y: 0, width: width, height: width * 3 / 4)]
		case 2:
			let h = (width / 2).rounded()
			return [CGRect(x: 0, y: 0, width: half, height: h), CGRect(x: far, y: 0, width: half, height: h)]
		case 3:
			let h = (width * 3 / 4).rounded()
			let top = ((h - gap) / 2).rounded(.down)
			return [
				CGRect(x: 0, y: 0, width: half, height: h),
				CGRect(x: far, y: 0, width: half, height: top),
				CGRect(x: far, y: h - top, width: half, height: top),
			]
		default:
			return [
				CGRect(x: 0, y: 0, width: half, height: half), CGRect(x: far, y: 0, width: half, height: half),
				CGRect(x: 0, y: far, width: half, height: half), CGRect(x: far, y: far, width: half, height: half),
			]
		}
	}

	static func blockSize(count: Int, width: CGFloat) -> CGSize {
		let frames = tileFrames(count: count, width: width)
		return CGSize(width: width, height: frames.map(\.maxY).max() ?? 0)
	}
}

// MARK: Pictures

enum ImagePhase {
	case loading
	case loaded(DecodedImage)
	/// Could not be fetched, or there is no loader (previews).
	case broken
}

/// Loads a picture from the thread's image cache and hands its phase to `content`, so a block can
/// size itself from the picture and a tile can draw it.
struct ImagePhaseReader<Content: View>: View {
	let file: ChatAttachmentRef
	@ViewBuilder let content: (ImagePhase) -> Content
	@Environment(\.attachmentImages) private var images
	@State private var loaded: DecodedImage?
	@State private var failed = false

	var body: some View {
		let image = loaded ?? images?.cached(file.fileID)
		let unloaded: ImagePhase = failed || images == nil ? .broken : .loading
		content(image.map { ImagePhase.loaded($0) } ?? unloaded)
			.task(id: file.fileID) {
				guard loaded == nil, let images, images.cached(file.fileID) == nil else { return }
				failed = false
				loaded = await images.load(file.fileID)
				failed = loaded == nil
			}
	}
}

/// What a tile shows, whatever its size: the picture cropped to fill, a skeleton while it loads,
/// the can't-load notice, and the upload layers on top. Takes its size from where it is placed.
struct ImageTileFace: View {
	let name: String
	let phase: ImagePhase
	var transfer: AttachmentTransfer = .ready
	/// The pictures past the fourth: shown as +N over a dim layer.
	var overflow = 0
	var onRetry: () -> Void = {}

	var body: some View {
		ZStack {
			switch phase {
			case .loaded(let image):
				Color.clear.overlay {
					Image(decorative: image.cgImage, scale: 3).resizable().scaledToFill()
				}
			case .loading:
				MaskinSurface.fill
					.overlay { Image(systemName: "photo").maskinSymbol(MaskinFontSize.t20).foregroundStyle(MaskinColor.ink5) }
					.accessibilityLabel("Loading image")
			case .broken:
				VStack(spacing: MaskinSpace.s2) {
					Image(systemName: "photo.badge.exclamationmark").maskinSymbol(MaskinFontSize.t20)
						.accessibilityHidden(true)
					Text(name).font(Self.small(.semibold)).foregroundStyle(MaskinColor.ink2).lineLimit(1)
						.truncationMode(.middle)
					Text("Can't load this image").font(Self.small(.regular))
				}
				.foregroundStyle(MaskinColor.ink4)
				.padding(.horizontal, MaskinSpace.s5)
				.frame(maxWidth: .infinity, maxHeight: .infinity)
				.background(MaskinSurface.cardInset2)
			}
			switch transfer {
			case .ready: EmptyView()
			case .uploading(let progress): uploading(progress)
			case .failed: failed
			}
			if overflow > 0, transfer == .ready {
				Text("+\(overflow)")
					.font(MaskinTypeface.sans(MaskinFontSize.t20, weight: .bold, relativeTo: .title3))
					.foregroundStyle(MaskinColor.ink)
					.frame(maxWidth: .infinity, maxHeight: .infinity)
					.background(Self.dim(0.7))
					.accessibilityHidden(true)
			}
		}
		.clipped()
	}

	private static func small(_ weight: Font.Weight) -> Font {
		MaskinTypeface.sans(MaskinFontSize.t12, weight: weight, relativeTo: .caption)
	}

	/// The page background over the picture: reads in both colour schemes.
	private static func dim(_ opacity: Double) -> Color { MaskinSurface.grouped.opacity(opacity) }

	private func uploading(_ progress: Double?) -> some View {
		VStack(spacing: MaskinSpace.s2) {
			ZStack {
				Circle().stroke(MaskinColor.ink.opacity(0.15), lineWidth: 3)
				if let progress {
					Circle().trim(from: 0, to: max(0.02, min(progress, 1)))
						.stroke(MaskinColor.sig, style: StrokeStyle(lineWidth: 3, lineCap: .round))
						.rotationEffect(.degrees(-90))
				} else {
					ProgressView().controlSize(.small)
				}
			}
			.frame(width: MaskinSpace.s12 + MaskinSpace.s4, height: MaskinSpace.s12 + MaskinSpace.s4)
			if let progress {
				Text("\(Int((min(max(progress, 0), 1) * 100).rounded()))%").font(Self.small(.semibold))
					.foregroundStyle(MaskinColor.ink)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(Self.dim(0.7))
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(
			progress.map { "Uploading \(name), \(Int(($0 * 100).rounded())) percent" } ?? "Uploading \(name)")
	}

	private var failed: some View {
		VStack(spacing: MaskinSpace.s2) {
			Image(systemName: "exclamationmark.circle").maskinSymbol(MaskinFontSize.t20).foregroundStyle(MaskinColor.danger)
				.accessibilityHidden(true)
			Text("Couldn't upload").font(Self.small(.semibold)).foregroundStyle(MaskinColor.ink)
			RetryButton(label: "Retry \(name)", action: onRetry)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(Self.dim(0.85))
		.overlay(Rectangle().strokeBorder(MaskinColor.danger, lineWidth: 2))
	}
}

/// The small outlined Retry button on a failed tile or card: 32pt drawn, 44pt to hit.
struct RetryButton: View {
	let label: String
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack(spacing: MaskinSpace.s2) {
				Image(systemName: "arrow.clockwise").maskinSymbol(MaskinFontSize.t12, weight: .semibold)
					.accessibilityHidden(true)
				Text("Retry").font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
			}
			.foregroundStyle(MaskinColor.ink)
			.padding(.horizontal, MaskinSpace.s7)
			.frame(minHeight: MaskinSpace.s14)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.btn, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: MaskinRadius.btn, style: .continuous)
					.strokeBorder(MaskinSurface.line, lineWidth: 1))
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel(label)
	}
}

extension View {
	/// 1pt hairline at 10% of the text colour, so a dark screenshot keeps its edge.
	fileprivate func tileHairline(radius: CGFloat) -> some View {
		overlay(
			RoundedRectangle(cornerRadius: radius, style: .continuous)
				.strokeBorder(MaskinColor.ink.opacity(0.1), lineWidth: 1)
				.allowsHitTesting(false))
	}
}

/// A message's pictures as one block outside the bubble: one picture in its own shape, two to four
/// as a grid, more with +N on the fourth. A tap opens the viewer on that picture.
struct MessageImageBlock: View {
	let images: [ChatAttachmentRef]
	/// Width of the block, from `AttachmentLayout.width`.
	let width: CGFloat
	var transfer: AttachmentTransfer = .ready
	var onRetry: () -> Void = {}
	@State private var viewing: ViewerStart?

	var body: some View {
		Group {
			if images.count == 1, let only = images.first {
				single(only)
			} else {
				grid
			}
		}
		.presentViewer($viewing) { start in
			ImageViewer(files: images, start: start.index)
		}
	}

	private func single(_ file: ChatAttachmentRef) -> some View {
		ImagePhaseReader(file: file) { phase in
			// The skeleton reserves a 4:3 block; a picture then takes its own shape.
			let ratio: CGFloat = {
				guard case .loaded(let image) = phase else { return 4.0 / 3.0 }
				return CGFloat(image.cgImage.width) / CGFloat(max(image.cgImage.height, 1))
			}()
			let size = AttachmentLayout.singleSize(ratio: ratio, width: width)
			tile(file, index: 0, phase: phase, radius: AttachmentLayout.blockRadius)
				.frame(width: size.width, height: size.height)
		}
	}

	private var grid: some View {
		let shown = Array(images.prefix(AttachmentLayout.maxTiles))
		let frames = AttachmentLayout.tileFrames(count: shown.count, width: width)
		let size = AttachmentLayout.blockSize(count: shown.count, width: width)
		let overflow = AttachmentLayout.overflow(images.count)
		return ZStack(alignment: .topLeading) {
			ForEach(Array(shown.enumerated()), id: \.element.id) { index, file in
				ImagePhaseReader(file: file) { phase in
					tile(file, index: index, phase: phase, radius: AttachmentLayout.tileRadius, overflow: index == 3 ? overflow : 0)
						.frame(width: frames[index].width, height: frames[index].height)
				}
				.offset(x: frames[index].minX, y: frames[index].minY)
			}
		}
		.frame(width: size.width, height: size.height, alignment: .topLeading)
		.clipShape(RoundedRectangle(cornerRadius: AttachmentLayout.blockRadius, style: .continuous))
		// Reads as a list with a count.
		.accessibilityElement(children: .contain)
		.accessibilityLabel("\(images.count) images")
	}

	@ViewBuilder
	private func tile(_ file: ChatAttachmentRef, index: Int, phase: ImagePhase, radius: CGFloat, overflow: Int = 0) -> some View {
		let name = file.name ?? "Image"
		let face = ImageTileFace(name: name, phase: phase, transfer: transfer, overflow: overflow, onRetry: onRetry)
			.clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
			.tileHairline(radius: radius)
		if transfer == .ready {
			Button { viewing = ViewerStart(index: index) } label: { face }
				.buttonStyle(.maskinPressed(.shrink))
				.accessibilityLabel("Image \(index + 1), \(name), open")
		} else {
			face
		}
	}
}

struct ViewerStart: Identifiable {
	let index: Int
	var id: Int { index }
}

extension View {
	/// Full screen on a phone; a sheet where there is no full-screen cover.
	fileprivate func presentViewer<Item: Identifiable, Content: View>(
		_ item: Binding<Item?>, @ViewBuilder content: @escaping (Item) -> Content
	) -> some View {
		#if os(iOS)
		fullScreenCover(item: item, content: content)
		#else
		sheet(item: item, content: content)
		#endif
	}
}

// MARK: Viewer

/// The in-app viewer: opens on the tapped picture with "2 of 4", previous and next, download and
/// close, and swipes between pictures. Download hands the file to the app's file screen, which
/// has the share sheet.
struct ImageViewer: View {
	let files: [ChatAttachmentRef]
	@State var index: Int
	@Environment(\.dismiss) private var dismiss
	@Environment(\.openAttachment) private var open

	init(files: [ChatAttachmentRef], start: Int) {
		self.files = files
		_index = State(initialValue: min(max(start, 0), max(files.count - 1, 0)))
	}

	var body: some View {
		VStack(spacing: 0) {
			bar
			ZStack {
				pages
				HStack {
					step(-1, symbol: "chevron.left", label: "Previous image")
					Spacer(minLength: 0)
					step(1, symbol: "chevron.right", label: "Next image")
				}
				.padding(.horizontal, MaskinSpace.s5)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(MaskinSurface.grouped.opacity(0.97).ignoresSafeArea())
		.accessibilityAddTraits(.isModal)
	}

	private var current: ChatAttachmentRef { files[index] }

	private var bar: some View {
		HStack(spacing: MaskinSpace.s3) {
			Text(current.name ?? "Image")
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
				.foregroundStyle(MaskinColor.ink).lineLimit(1).truncationMode(.middle)
				.frame(maxWidth: .infinity, alignment: .leading)
			Text("\(index + 1) of \(files.count)")
				.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption)).foregroundStyle(MaskinColor.ink4)
				.monospacedDigit()
			barButton("arrow.down.to.line", label: "Download") {
				let id = current.fileID
				dismiss()
				// The file screen is a sheet; let this cover finish leaving before it comes up.
				Task {
					try? await Task.sleep(for: .milliseconds(350))
					open?(id)
				}
			}
			barButton("xmark", label: "Close viewer") { dismiss() }
		}
		.padding(.leading, MaskinSpace.s9)
		.padding(.trailing, MaskinSpace.s3)
		.padding(.vertical, MaskinSpace.s2)
	}

	private func barButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Image(systemName: symbol).maskinSymbol(MaskinFontSize.t16, weight: .semibold)
				.foregroundStyle(MaskinColor.ink3)
				.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
				.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel(label)
	}

	@ViewBuilder
	private var pages: some View {
		#if os(iOS)
		TabView(selection: $index) {
			ForEach(Array(files.enumerated()), id: \.element.id) { i, file in
				page(file).tag(i)
			}
		}
		.tabViewStyle(.page(indexDisplayMode: .never))
		#else
		page(current)
		#endif
	}

	private func page(_ file: ChatAttachmentRef) -> some View {
		ImagePhaseReader(file: file) { phase in
			switch phase {
			case .loaded(let image):
				Image(decorative: image.cgImage, scale: 3).resizable().scaledToFit()
					.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.panelLg, style: .continuous))
					.tileHairline(radius: MaskinRadius.panelLg)
					.padding(MaskinSpace.s9)
					.accessibilityLabel("Image, \(file.name ?? "")")
			case .loading:
				ProgressView()
			case .broken:
				Text("Can't load this image").font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink4)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}

	private func step(_ delta: Int, symbol: String, label: String) -> some View {
		let target = index + delta
		return Button {
			withAnimation(MaskinMotion.standard) { index = target }
		} label: {
			Image(systemName: symbol).maskinSymbol(MaskinFontSize.t16, weight: .semibold)
				.foregroundStyle(MaskinColor.ink)
				.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
				.background(MaskinSurface.card, in: Circle())
				.overlay(Circle().strokeBorder(MaskinSurface.line, lineWidth: 1))
		}
		.buttonStyle(.maskinPressed)
		.opacity(files.indices.contains(target) ? 1 : 0)
		.disabled(!files.indices.contains(target))
		.accessibilityLabel(label)
		.accessibilityHidden(!files.indices.contains(target))
	}
}

// MARK: Files

enum AttachmentFileState: Equatable {
	case ready
	case uploading(progress: Double?)
	case failed
	/// The file was removed: struck-through name, no actions.
	case gone

	init(_ transfer: AttachmentTransfer) {
		switch transfer {
		case .ready: self = .ready
		case .uploading(let progress): self = .uploading(progress: progress)
		case .failed: self = .failed
		}
	}
}

/// How a file is tagged: its extension in mono, in the colour of its kind.
struct FileTypeTag: Equatable {
	let text: String
	let tone: Color

	init(name: String?, mimeType: String?) {
		var ext = ((name ?? "") as NSString).pathExtension.lowercased()
		if ext.isEmpty, (mimeType ?? "").lowercased() == "application/pdf" { ext = "pdf" }
		text = ext.isEmpty ? "FILE" : String(ext.uppercased().prefix(4))
		switch ext {
		case "pdf": tone = MaskinColor.danger
		case "md", "markdown", "txt", "doc", "docx", "pages": tone = MaskinColor.sig
		case "xls", "xlsx", "csv", "numbers": tone = MaskinColor.objTask
		case "zip", "gz", "tar", "rar", "7z": tone = MaskinColor.warning
		default: tone = MaskinColor.ink3
		}
	}

	/// "PDF · 2.4 MB": the type and, when known, the size. Never a page count.
	func meta(sizeBytes: Int?) -> String {
		[text, ChatByteFormat.string(sizeBytes)].compactMap { $0 }.joined(separator: " · ")
	}
}

/// One file as a card outside the bubble: its type tag, name (truncates), type and size, and a
/// download button. The whole card opens the file. Uploading, failed and gone files have their own
/// cards. A PDF shows the same tag tile as any file: the API gives no first-page preview yet.
struct MessageFileCard: View {
	let file: ChatAttachmentRef
	var state: AttachmentFileState = .ready
	var onOpen: () -> Void = {}
	var onDownload: () -> Void = {}
	var onRetry: () -> Void = {}
	var onCancel: () -> Void = {}

	private var name: String { file.name ?? "Attachment" }
	private var tag: FileTypeTag { FileTypeTag(name: file.name, mimeType: file.mimeType) }

	var body: some View {
		Group {
			switch state {
			case .ready: ready
			case .uploading(let progress): uploading(progress)
			case .failed: failed
			case .gone: gone
			}
		}
		.padding(.vertical, MaskinSpace.s5)
		.padding(.leading, MaskinSpace.s5)
		.padding(.trailing, MaskinSpace.s3)
		.background(MaskinSurface.card, in: shape)
		.overlay(shape.strokeBorder(border, lineWidth: 1))
		.opacity(state == .gone ? 0.8 : 1)
	}

	private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: MaskinRadius.panel, style: .continuous) }

	private var border: Color {
		switch state {
		case .failed: MaskinColor.danger
		case .gone: MaskinSurface.separator
		default: MaskinSurface.line
		}
	}

	private var tile: some View {
		Text(tag.text)
			.font(MaskinTypeface.mono(MaskinFontSize.t10, weight: .bold, relativeTo: .caption2))
			.foregroundStyle(tag.tone)
			.frame(width: MaskinSpace.s12 + MaskinSpace.s9, height: MaskinSpace.s12 + MaskinSpace.s9)
			.background(
				tag.tone.opacity(0.14), in: RoundedRectangle(cornerRadius: MaskinRadius.btn, style: .continuous)
			)
			.accessibilityHidden(true)
	}

	private func nameText(struck: Bool = false) -> some View {
		Text(name).font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
			.foregroundStyle(struck ? MaskinColor.ink4 : MaskinColor.ink)
			.strikethrough(struck)
			.lineLimit(1).truncationMode(.middle)
	}

	private func caption(_ text: String, color: Color = MaskinColor.ink4) -> some View {
		Text(text).font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption)).foregroundStyle(color)
			.lineLimit(1)
	}

	private var ready: some View {
		HStack(spacing: MaskinSpace.s3) {
			Button(action: onOpen) {
				HStack(spacing: MaskinSpace.s7) {
					tile
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						nameText()
						caption(tag.meta(sizeBytes: file.sizeBytes))
					}
					.frame(maxWidth: .infinity, alignment: .leading)
				}
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityLabel("Open \(name)")
			iconButton("arrow.down.to.line", label: "Download \(name)", action: onDownload)
		}
	}

	private func uploading(_ progress: Double?) -> some View {
		HStack(spacing: MaskinSpace.s7) {
			tile
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				nameText()
				if let progress {
					ProgressView(value: min(max(progress, 0), 1)).tint(MaskinColor.sig)
					caption("Uploading, \(Int((min(max(progress, 0), 1) * 100).rounded()))%")
				} else {
					ProgressView().controlSize(.small)
					caption("Uploading")
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			iconButton("xmark", label: "Cancel upload of \(name)", action: onCancel)
		}
		.accessibilityElement(children: .contain)
	}

	private var failed: some View {
		HStack(spacing: MaskinSpace.s7) {
			tile
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				nameText()
				HStack(spacing: MaskinSpace.s1) {
					Image(systemName: "exclamationmark.circle").maskinSymbol(MaskinFontSize.t12).accessibilityHidden(true)
					Text("Couldn't upload")
				}
				.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .semibold, relativeTo: .caption))
				.foregroundStyle(MaskinColor.danger).lineLimit(1)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			RetryButton(label: "Retry \(name)", action: onRetry)
		}
	}

	private var gone: some View {
		HStack(spacing: MaskinSpace.s7) {
			tile
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				nameText(struck: true)
				caption("File no longer available")
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.accessibilityElement(children: .combine)
	}

	private func iconButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Image(systemName: symbol).maskinSymbol(MaskinFontSize.t14, weight: .semibold)
				.foregroundStyle(MaskinColor.ink4)
				.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
				.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel(label)
	}
}

// MARK: The stack

/// What a message attaches, outside its bubble: the pictures as one block, then the files as cards,
/// 4pt apart, on the message's side. The text bubble, when there is text, follows below.
struct MessageAttachments: View {
	let attachments: [ChatAttachmentRef]
	var alignment: HorizontalAlignment = .leading
	/// The width of the thread, to size the blocks from. 0 until it is measured.
	var threadWidth: CGFloat = 0
	var transfer: AttachmentTransfer = .ready
	var onRetry: () -> Void = {}
	@Environment(\.openAttachment) private var open

	var body: some View {
		if !attachments.isEmpty {
			let photos = attachments.filter(\.isImage)
			let files = attachments.filter { !$0.isImage }
			VStack(alignment: alignment, spacing: AttachmentLayout.gap) {
				if !photos.isEmpty {
					MessageImageBlock(
						images: photos, width: AttachmentLayout.width(thread: threadWidth, fraction: AttachmentLayout.imageFraction),
						transfer: transfer, onRetry: onRetry)
				}
				ForEach(files) { file in
					MessageFileCard(
						file: file, state: AttachmentFileState(transfer),
						onOpen: { open?(file.fileID) }, onDownload: { open?(file.fileID) }, onRetry: onRetry
					)
					.frame(width: AttachmentLayout.width(thread: threadWidth, fraction: AttachmentLayout.fileFraction))
				}
			}
			.frame(maxWidth: .infinity, alignment: alignment == .trailing ? .trailing : .leading)
		}
	}
}

#if DEBUG
private let previewPhoto: DecodedImage = {
	let context = CGContext(
		data: nil, width: 600, height: 400, bitsPerComponent: 8, bytesPerRow: 0,
		space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
	let colors = [CGColor(red: 0.18, green: 0.45, blue: 0.95, alpha: 1), CGColor(red: 0.62, green: 0.22, blue: 0.85, alpha: 1)]
	let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1])!
	context.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 600, y: 400), options: [])
	return DecodedImage(context.makeImage()!)
}()

private func previewPhotos(_ count: Int) -> [ChatAttachmentRef] {
	(1...count).map { ChatAttachmentRef(fileID: "img\($0)", name: "photo-\($0).jpg", mimeType: "image/jpeg", sizeBytes: 90_000) }
}

#Preview("Attachment states") {
	let pdf = ChatAttachmentRef(fileID: "f1", name: "Q3-pipeline-review.pdf", mimeType: "application/pdf", sizeBytes: 2_400_000)
	ScrollView {
		VStack(alignment: .trailing, spacing: MaskinSpace.s9) {
			ForEach([1, 2, 3, 4, 6], id: \.self) { count in
				MessageAttachments(attachments: previewPhotos(count), alignment: .trailing, threadWidth: 370)
			}
			MessageAttachments(attachments: previewPhotos(1), alignment: .trailing, threadWidth: 370, transfer: .uploading(progress: nil))
			MessageAttachments(attachments: previewPhotos(4), alignment: .trailing, threadWidth: 370, transfer: .failed)
			MessageFileCard(file: pdf)
			MessageFileCard(file: pdf, state: .uploading(progress: 0.4))
			MessageFileCard(file: pdf, state: .failed)
			MessageFileCard(file: pdf, state: .gone)
		}
		.padding(MaskinSpace.s9)
	}
	.environment(\.attachmentImages, AttachmentImages(cached: { _ in previewPhoto }, load: { _ in previewPhoto }))
	.background(MaskinSurface.grouped)
}

#Preview("Image viewer") {
	ImageViewer(files: previewPhotos(4), start: 1)
		.environment(\.attachmentImages, AttachmentImages(cached: { _ in previewPhoto }, load: { _ in previewPhoto }))
}
#endif
