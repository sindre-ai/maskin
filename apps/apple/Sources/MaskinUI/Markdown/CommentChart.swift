import Charts
import Foundation
import MaskinDesign
import SwiftUI

/// The spec an agent writes in a ```chart fence in a comment: `{"type":"bar|line|area","x":"week",
/// "series":["clicks"],"data":[{"week":"W1","clicks":120}],"caption":"..."}`. The same shape the web
/// renders, so one comment draws on both.
public struct CommentChartSpec: Equatable, Sendable {
	public enum Kind: String, Sendable { case bar, line, area }

	public struct Point: Equatable, Sendable, Identifiable {
		public var id: String { "\(series)|\(label)" }
		public let label: String
		public let series: String
		public let value: Double
	}

	public let kind: Kind
	public let points: [Point]
	public let seriesNames: [String]
	public let caption: String?

	public enum ParseResult: Equatable, Sendable {
		case chart(CommentChartSpec)
		/// Plain words for a reader; never the JSON error.
		case failed(String)
		/// A fence a streaming render has not filled yet: draw nothing.
		case empty
	}

	public static func parse(_ source: String) -> ParseResult {
		let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
		if trimmed.isEmpty { return .empty }
		guard let data = trimmed.data(using: .utf8),
			let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
		else { return .failed("the chart data is incomplete or malformed") }
		guard let typeName = object["type"] as? String, let kind = Kind(rawValue: typeName) else {
			return .failed("unknown chart type")
		}
		guard let x = object["x"] as? String, !x.isEmpty else { return .failed("the chart is missing its x field") }
		guard let series = object["series"] as? [String], !series.isEmpty, !series.contains(where: \.isEmpty) else {
			return .failed("the chart needs a list of series")
		}
		guard let rows = object["data"] as? [[String: Any]] else { return .failed("the chart needs data") }
		var points: [Point] = []
		for row in rows {
			let label: String
			switch row[x] {
			case let s as String: label = s
			case let n as NSNumber: label = n.stringValue
			default: continue
			}
			for name in series {
				if let n = row[name] as? NSNumber, !(row[name] is Bool) {
					points.append(Point(label: label, series: name, value: n.doubleValue))
				}
			}
		}
		return .chart(
			CommentChartSpec(
				kind: kind, points: points, seriesNames: series, caption: object["caption"] as? String))
	}
}

/// A comment's chart: a quiet card with the plot and the caption.
public struct CommentChartView: View {
	let spec: CommentChartSpec

	public init(spec: CommentChartSpec) { self.spec = spec }

	public var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			Chart(spec.points) { point in
				switch spec.kind {
				case .bar:
					BarMark(x: .value("x", point.label), y: .value(point.series, point.value))
						.foregroundStyle(by: .value("Series", point.series))
						.position(by: .value("Series", point.series))
				case .line:
					LineMark(x: .value("x", point.label), y: .value(point.series, point.value))
						.foregroundStyle(by: .value("Series", point.series))
						.interpolationMethod(.monotone)
				case .area:
					AreaMark(x: .value("x", point.label), y: .value(point.series, point.value))
						.foregroundStyle(by: .value("Series", point.series))
						.interpolationMethod(.monotone)
				}
			}
			.chartForegroundStyleScale(range: Self.palette)
			.chartLegend(spec.seriesNames.count > 1 ? .visible : .hidden)
			.chartYAxis { AxisMarks { AxisValueLabel().foregroundStyle(MaskinColor.ink5) } }
			.chartXAxis { AxisMarks { AxisValueLabel().foregroundStyle(MaskinColor.ink5) } }
			.frame(height: MaskinSpace.s14 * 4)
			if let caption = spec.caption, !caption.isEmpty {
				Text(caption)
					.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
					.foregroundStyle(MaskinColor.ink4)
			}
		}
		.padding(MaskinSpace.s8)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(
			"Chart. " + (spec.caption ?? "") + " "
				+ spec.points.map { "\($0.label) \($0.series) \($0.value.formatted())" }.joined(separator: ", "))
	}

	/// First series in the brand ink, the rest stepping down in tone, as on the web.
	private static let palette: [Color] = [MaskinColor.sigInk, MaskinColor.ink3, MaskinColor.ink4, MaskinColor.ink5]
}

/// What a ```chart fence draws: the chart, a plain note when the spec is broken, nothing while empty.
struct MarkdownChartBlock: View {
	let source: String

	var body: some View {
		switch CommentChartSpec.parse(source) {
		case .chart(let spec): CommentChartView(spec: spec)
		case .failed(let reason):
			Text("Couldn\u{2019}t draw this chart: \(reason).")
				.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
				.foregroundStyle(MaskinColor.ink4)
		case .empty: EmptyView()
		}
	}
}
