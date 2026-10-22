import MaskinCore
import MaskinUI

extension ObjectPreviewMetaView {
	/// The To / Cc / Subject / detail lines and the missing and warning notes of a server preview.
	public init(preview: ObjectPreview) {
		self.init(
			rows: preview.metaRows.map { .init(label: $0.label, value: $0.value) },
			missing: preview.missing, warnings: preview.warnings)
	}
}
