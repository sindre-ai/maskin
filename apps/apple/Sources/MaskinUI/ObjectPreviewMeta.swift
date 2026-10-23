import MaskinDesign
import SwiftUI

/// The lines above a draft's text: To, Cc, Subject and the kind's own details ("Posting as",
/// "Channel"), then what is missing and what to check before approving. Stateless; it takes plain
/// values so it needs no model (`ObjectPreviewMetaView(preview:)` in MaskinFeatures builds it from
/// an `ObjectPreview`).
public struct ObjectPreviewMetaView: View {
	public struct Row: Sendable, Equatable, Hashable {
		public var label: String
		public var value: String
		public init(label: String, value: String) {
			self.label = label
			self.value = value
		}
	}

	let rows: [Row]
	let missing: [String]
	let warnings: [String]

	public init(rows: [Row], missing: [String] = [], warnings: [String] = []) {
		self.rows = rows
		self.missing = missing
		self.warnings = warnings
	}

	public var body: some View {
		if !rows.isEmpty || !missing.isEmpty || !warnings.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
					HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s5) {
						Text(row.label)
							.font(MaskinTypeface.sans(MaskinFontSize.t14))
							.foregroundStyle(MaskinColor.ink5)
							.frame(width: 72, alignment: .leading)
						Text(row.value)
							.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: MaskinFontWeight.w650))
							.foregroundStyle(MaskinColor.ink)
							.frame(maxWidth: .infinity, alignment: .leading)
					}
					.accessibilityElement(children: .combine)
				}
				if !missing.isEmpty {
					note("Missing: \(missing.joined(separator: ", "))")
				}
				ForEach(warnings, id: \.self) { note($0) }
				Rectangle().fill(MaskinSurface.separator).frame(height: 1)
			}
		}
	}

	private func note(_ text: String) -> some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
			Image(systemName: "exclamationmark.triangle.fill")
				.font(MaskinTypeface.sans(MaskinFontSize.t12))
				.accessibilityHidden(true)
			Text(text)
				.font(MaskinTypeface.sans(MaskinFontSize.t13))
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.foregroundStyle(MaskinColor.warningStrong)
		.accessibilityElement(children: .combine)
	}
}
