import AVKit
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// How a draft card gets the files that go out with a draft. Supplied by the app root, which owns
/// the file client; absent in previews and tests, where nothing is drawn.
struct PreviewMediaLoader: Sendable {
	/// The files for a draft's ids, in order, unreadable ones left out.
	var items: @Sendable @MainActor ([String]) async -> [PreviewMediaItem]
	/// The whole file, for a video that is played here.
	var file: @Sendable @MainActor (String) async throws -> FileDetail
}

extension EnvironmentValues {
	@Entry var previewMedia: PreviewMediaLoader? = nil
}

/// Everything that goes out with a draft, under its text: a post's pictures as one paged strip
/// ("3 / 7", swipe, dots), a video that plays on tap, a document as its file row. Reads the files the
/// draft lists, nothing else on the object. A file nobody can read is simply not drawn.
struct PreviewMediaStrip: View {
	let ids: [String]
	/// Items already known, for previews and snapshots; otherwise they are loaded.
	var preloaded: [PreviewMediaItem]?
	@Environment(\.previewMedia) private var loader
	@State private var loaded: [PreviewMediaItem]?
	@State private var page: String?

	init(ids: [String], preloaded: [PreviewMediaItem]? = nil) {
		self.ids = ids
		self.preloaded = preloaded
	}

	private var items: [PreviewMediaItem]? { preloaded ?? loaded }

	var body: some View {
		Group {
			if let items {
				if !items.isEmpty { strip(items) }
			} else if !ids.isEmpty, loader != nil {
				RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
					.fill(MaskinSurface.fill)
					.frame(height: Self.height)
					.overlay { ProgressView().controlSize(.small) }
					.accessibilityLabel("Loading media")
			}
		}
		.task(id: ids) {
			guard preloaded == nil, !ids.isEmpty, let loader else { return }
			loaded = await loader.items(ids)
		}
	}

	/// A slide is 4:5 (a LinkedIn carousel is 1080 by 1350); the strip is that tall at most.
	static let height: CGFloat = 360

	@ViewBuilder
	private func strip(_ items: [PreviewMediaItem]) -> some View {
		let current = items.firstIndex { $0.id == page } ?? 0
		VStack(spacing: MaskinSpace.s3) {
			ScrollView(.horizontal, showsIndicators: false) {
				LazyHStack(spacing: MaskinSpace.s3) {
					ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
						PreviewMediaPage(item: item)
							.containerRelativeFrame(.horizontal)
							.id(item.id)
							.accessibilityElement(children: .contain)
							.accessibilityLabel(PreviewMedia.accessibilityLabel(for: item, index: index, count: items.count))
					}
				}
				.scrollTargetLayout()
			}
			.scrollTargetBehavior(.viewAligned)
			.scrollPosition(id: $page)
			.frame(height: Self.height)
			if items.count > 1 {
				HStack(spacing: MaskinSpace.s4) {
					Text(PreviewMedia.counterText(index: current, count: items.count))
						.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: MaskinFontWeight.w650))
						.foregroundStyle(MaskinColor.ink4)
						.monospacedDigit()
					Spacer(minLength: 0)
					HStack(spacing: MaskinSpace.s2) {
						ForEach(Array(items.enumerated()), id: \.element.id) { index, _ in
							Circle().fill(index == current ? MaskinColor.ink3 : MaskinSurface.line)
								.frame(width: 6, height: 6)
						}
					}
					.accessibilityHidden(true)
				}
				.accessibilityElement(children: .ignore)
				.accessibilityLabel("Showing \(current + 1) of \(items.count)")
			}
		}
	}
}

/// One page of the strip: a picture drawn whole (never cropped), a video, or a file row.
private struct PreviewMediaPage: View {
	let item: PreviewMediaItem
	@Environment(\.attachmentImages) private var images
	@Environment(\.openAttachment) private var open
	@State private var picture: DecodedImage?
	@State private var failed = false

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
		Group {
			switch item.kind {
			case .image: image
			case .video: PreviewVideoPage(file: item.file)
			case .other: fileRow
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(MaskinSurface.fill, in: shape)
		.clipShape(shape)
		.overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
	}

	@ViewBuilder
	private var image: some View {
		let loaded = picture ?? images?.cached(item.file.id)
		Group {
			if let loaded {
				Button { open?(item.file.id) } label: {
					Image(decorative: loaded.cgImage, scale: 1).resizable().scaledToFit()
				}
				.buttonStyle(.maskinPressed(.shrink))
				.accessibilityLabel(item.file.name)
				.accessibilityHint("Opens the file")
			} else if failed || images == nil {
				fileRow
			} else {
				ProgressView().controlSize(.small)
			}
		}
		.task(id: item.file.id) {
			guard picture == nil, let images, images.cached(item.file.id) == nil else { return }
			failed = false
			picture = await images.load(item.file.id)
			failed = picture == nil
		}
	}

	private var fileRow: some View {
		Button { open?(item.file.id) } label: {
			VStack(spacing: MaskinSpace.s4) {
				Image(systemName: item.kind == .video ? "play.rectangle" : "doc")
					.font(MaskinTypeface.sans(MaskinFontSize.t24)).foregroundStyle(MaskinColor.ink3)
					.accessibilityHidden(true)
				Text(item.file.name).maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink).lineLimit(2).truncationMode(.middle)
					.multilineTextAlignment(.center)
				Text(
					[FileContentKind.label(forMime: item.file.mimeType), ChatByteFormat.string(item.file.sizeBytes)]
						.compactMap { $0 }.joined(separator: " · ")
				)
				.maskinText(.microLabel).foregroundStyle(MaskinColor.ink5)
			}
			.padding(MaskinSpace.s6)
			.frame(maxWidth: .infinity, maxHeight: .infinity)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel("\(FileContentKind.label(forMime: item.file.mimeType)), \(item.file.name)")
		.accessibilityHint("Opens the file")
	}
}

/// A video: a play tile until it is tapped (nothing downloads or autoplays), then the system player.
/// A video too big to hold in memory is a file row that opens the viewer.
private struct PreviewVideoPage: View {
	let file: FileReference
	@Environment(\.previewMedia) private var loader
	@Environment(\.openAttachment) private var open
	@State private var phase: Phase = .idle

	private enum Phase {
		case idle, loading, ready(AVPlayer), failed
	}

	private var playable: Bool { file.sizeBytes <= PreviewMedia.maxPlayableVideoBytes && loader != nil }

	var body: some View {
		switch phase {
		case .ready(let player):
			VideoPlayer(player: player)
		case .loading:
			ProgressView().controlSize(.small)
		case .idle, .failed:
			Button {
				if playable { Task { await load() } } else { open?(file.id) }
			} label: {
				VStack(spacing: MaskinSpace.s4) {
					Image(systemName: playable ? "play.circle.fill" : "arrow.up.forward.square")
						.font(MaskinTypeface.sans(MaskinFontSize.t24)).foregroundStyle(MaskinColor.ink3)
						.accessibilityHidden(true)
					Text(file.name).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
						.lineLimit(2).truncationMode(.middle).multilineTextAlignment(.center)
					if case .failed = phase {
						Text("Couldn't load this video. Tap to try again.")
							.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					} else if let size = ChatByteFormat.string(file.sizeBytes) {
						Text(size).maskinText(.microLabel).foregroundStyle(MaskinColor.ink5)
					}
				}
				.padding(MaskinSpace.s6)
				.frame(maxWidth: .infinity, maxHeight: .infinity)
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed(.shrink))
			.accessibilityLabel("Video, \(file.name)")
			.accessibilityHint(playable ? "Plays the video" : "Opens the file")
		}
	}

	private func load() async {
		guard let loader else { return }
		phase = .loading
		do {
			let detail = try await loader.file(file.id)
			let ext = (file.name as NSString).pathExtension
			let url = FileManager.default.temporaryDirectory
				.appendingPathComponent("preview-\(file.id)").appendingPathExtension(ext.isEmpty ? "mp4" : ext)
			try detail.data.write(to: url, options: .atomic)
			phase = .ready(AVPlayer(url: url))
		} catch {
			phase = .failed
		}
	}
}
