import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import CoreTransferable
import SwiftUI
import UniformTypeIdentifiers

/// A file viewer: header, content routed by type, and review comments you can pin, edit and delete.
///
///     FileScreen(environment: env, fileId: id)
public struct FileScreen: View {
	@State private var store: FileStore

	public init(environment: AppEnvironment, fileId: String) {
		_store = State(
			initialValue: FileStore(fileId: fileId, remote: APIFilesRemote(
					client: environment.client, credentials: environment.auth.credentialsProvider)))
	}

	init(store: FileStore) {
		_store = State(initialValue: store)
	}

	public var body: some View {
		FileScreenBody(store: store)
			.ambientBackground()
			.navigationTitle(store.file?.name ?? "")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				if let file = store.file {
					ToolbarItem(placement: .primaryAction) {
						// The bytes are written only when the person actually shares.
						ShareLink(item: FileExport(file: file), preview: SharePreview(file.name)) {
							Label("Share", systemImage: "square.and.arrow.up")
						}
					}
				}
			}
			.onDisappear { FileStore.clearExports() }
			.task { await store.load() }
			.refreshable { await store.load() }
	}
}

/// Everything under the navigation chrome, so snapshots can render it without a stack.
struct FileScreenBody: View {
	let store: FileStore
	/// Snapshots render without the scroll view, which `ImageRenderer` can't draw.
	var scrolls = true

	var body: some View {
		switch store.phase {
		case .idle, .loading:
			LoadingSkeleton(rows: 6).padding(MaskinSpace.s9)
		case .failed(let message):
			EmptyState(
				symbol: store.isNotFound ? "questionmark.folder" : store.isOffline ? "wifi.slash" : "exclamationmark.triangle",
				title: store.isNotFound ? "File not found" : "Couldn't open this file", message: message
			) {
				if !store.isNotFound {
					Button("Try again") { Task { await store.load() } }
						.buttonStyle(SecondaryActionButtonStyle())
				}
			}
		case .loaded:
			if let file = store.file { loaded(file) }
		}
	}

	private func loaded(_ file: FileDetail) -> some View {
		let content = FileLoadedContent(store: store, file: file)
			.padding(MaskinSpace.s9)
			.frame(maxWidth: 760, alignment: .leading)
			.frame(maxWidth: .infinity)
		return Group {
			if scrolls { ScrollView { content } } else { content }
		}
	}
}

/// A loaded file's header, content and review comments, without a scroll view (snapshot-friendly).
struct FileLoadedContent: View {
	let store: FileStore
	let file: FileDetail
	@State private var showsSource = false
	@State private var isAnnotating: Bool
	@State private var target: FilePinTarget?
	@State private var probe = HTMLProbe()

	init(store: FileStore, file: FileDetail) {
		self.store = store
		self.file = file
		// Open straight into pin mode when the page already has comments, like the web.
		_isAnnotating = State(initialValue: file.kind == .html && !file.annotations.isEmpty)
	}

	private var isHTML: Bool { file.kind == .html }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			header(file)
			if file.kind == .markdown || isHTML {
				HStack(spacing: MaskinSpace.s7) {
					Picker("View", selection: $showsSource) {
						Text("Rendered").tag(false)
						Text("Source").tag(true)
					}
					.pickerStyle(.segmented)
					if isHTML && !showsSource { annotateToggle }
				}
			}
			if isHTML && !showsSource {
				FileHTMLView(
					html: store.text ?? file.text ?? "", revision: store.contentRevision, name: file.name,
					annotations: store.annotations, draft: store.draft, isAnnotating: isAnnotating, probe: probe,
					onPlace: place, onSelect: { select($0.id) })
			} else {
				FileContentView(file: file, showsSource: showsSource, text: store.text, revision: store.contentRevision)
			}
			FormError(store.saveError)
			if !store.annotations.isEmpty {
				FileReviewComments(annotations: store.annotations, onSelect: { select($0.id) })
			}
		}
		.sheet(item: $target, onDismiss: { store.cancelDraft() }) { sheet(for: $0) }
		.onChange(of: showsSource) { _, source in if source { isAnnotating = false } }
	}

	private var annotateToggle: some View {
		Button {
			isAnnotating.toggle()
			MaskinHaptics.play(.selection)
		} label: {
			Label(
				store.annotations.isEmpty ? "Annotate" : "Annotate (\(store.annotations.count))",
				systemImage: isAnnotating ? "pin.fill" : "pin"
			)
			.maskinText(.subhead)
			.foregroundStyle(isAnnotating ? MaskinColor.ink : MaskinColor.ink2)
			.padding(.horizontal, MaskinSpace.s8)
			.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s4)
			.background(isAnnotating ? MaskinSurface.fillStrong : MaskinSurface.fill, in: Capsule())
			.fixedSize()
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityAddTraits(isAnnotating ? .isSelected : [])
	}

	private func select(_ id: String) {
		MaskinHaptics.play(.selection)
		target = .existing(id)
	}

	private func place(_ point: FilePoint) {
		// A tap on or near an existing pin opens it rather than stacking a second one.
		if let near = FileAnnotationRules.pin(near: point, in: store.annotations) {
			select(near.id)
			return
		}
		guard store.beginPin(at: point) else {
			MaskinHaptics.play(.warning)
			return
		}
		MaskinHaptics.play(.medium)
		target = .draft
		Task {
			if let hit = await probe.element(at: point) {
				store.resolveDraftTarget(selector: hit.selector, bounds: hit.bounds)
			}
		}
	}

	@ViewBuilder
	private func sheet(for target: FilePinTarget) -> some View {
		switch target {
		case .draft:
			if let draft = store.draft {
				PinCommentSheet(
					number: draft.pinNumber ?? 0, selector: draft.selector, initialComment: "", isNew: true,
					onSave: { comment in
						Task {
							await store.commitDraft(comment: comment)
							MaskinHaptics.play(store.saveError == nil ? .success : .error)
						}
					}, onDelete: nil)
			}
		case .existing(let id):
			if let pin = store.annotations.first(where: { $0.id == id }) {
				PinCommentSheet(
					number: pin.pinNumber ?? 0, selector: pin.selector, initialComment: pin.comment, isNew: false,
					onSave: { comment in
						Task {
							await store.updateComment(id: id, comment: comment)
							MaskinHaptics.play(store.saveError == nil ? .success : .error)
						}
					},
					onDelete: {
						Task {
							await store.remove(id: id)
							MaskinHaptics.play(store.saveError == nil ? .warning : .error)
						}
					})
			}
		}
	}

	private func header(_ file: FileDetail) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			Text(file.name).maskinText(.title).foregroundStyle(MaskinColor.ink)
			HStack(spacing: MaskinSpace.s3) {
				MonoLabel(FileContentKind.label(forMime: file.mimeType))
				Text("·")
				Text(FileStore.sizeText(file.sizeBytes))
				if file.updatedAt != nil {
					Text("·")
					RelativeTime(file.updatedAt)
				}
			}
			.maskinText(.caption)
			.foregroundStyle(MaskinColor.ink4)
			if let description = file.description, !description.isEmpty {
				Text(description).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			}
		}
	}
}

/// Hands the file to the share sheet lazily: the temp file is created only if a share happens.
struct FileExport: Transferable {
	let file: FileDetail

	static var transferRepresentation: some TransferRepresentation {
		FileRepresentation(exportedContentType: .data) { export in
			SentTransferredFile(try FileExporter.write(export.file))
		}
	}
}
