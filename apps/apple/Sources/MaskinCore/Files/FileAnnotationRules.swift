import Foundation

/// Pure rules for review pins, shared by the store and the views. Mirrors the web's
/// `lib/annotations.ts` and the server's limits (500-character comments, 200 pins).
public enum FileAnnotationRules {
	public static let maxComment = 500
	public static let maxCount = 200
	/// Taps closer than this (as a fraction of the page) to an existing pin open it instead of
	/// stacking a second pin on top.
	public static let hitRadius = 0.035

	/// Comment as it will be saved: trimmed and cut to the server limit.
	public static func sanitized(_ comment: String) -> String {
		String(comment.trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxComment))
	}

	/// The number the next pin gets: one past the highest in use.
	public static func nextPinNumber(in annotations: [FileAnnotation]) -> Int {
		(annotations.compactMap(\.pinNumber).max() ?? annotations.count) + 1
	}

	/// Pins from other clients may lack a number or position. Backfill the number by order and the
	/// position from the element's centre so every pin can be drawn (same as the web).
	public static func hydrated(_ stored: [FileAnnotation]) -> [FileAnnotation] {
		stored.enumerated().map { index, a in
			var a = a
			if a.pinNumber == nil { a.pinNumber = index + 1 }
			if a.position == nil {
				a.position = FilePoint(x: a.bounds.x + a.bounds.w / 2, y: a.bounds.y + a.bounds.h / 2).clamped
			}
			return a
		}
	}

	/// The pin nearest `point` within `hitRadius`, if any.
	public static func pin(near point: FilePoint, in annotations: [FileAnnotation]) -> FileAnnotation? {
		annotations
			.compactMap { a -> (FileAnnotation, Double)? in
				guard let p = a.position else { return nil }
				let d = ((p.x - point.x) * (p.x - point.x) + (p.y - point.y) * (p.y - point.y)).squareRoot()
				return d <= hitRadius ? (a, d) : nil
			}
			.min { $0.1 < $1.1 }?.0
	}

	/// The same JSON the web's "Copy annotation JSON" produces, for pasting into an agent prompt.
	public static func exportJSON(_ annotations: [FileAnnotation]) -> String {
		struct Entry: Encodable {
			var id: String
			var bounds: FileBounds
			var selector: String?
			var comment: String
		}
		struct Payload: Encodable { var annotations: [Entry] }
		let payload = Payload(
			annotations: annotations.map {
				Entry(
					id: $0.id, bounds: $0.bounds, selector: $0.selector.isEmpty ? nil : $0.selector,
					comment: $0.comment)
			})
		let encoder = JSONEncoder()
		encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
		guard let data = try? encoder.encode(payload), let text = String(data: data, encoding: .utf8) else {
			return "{\"annotations\":[]}"
		}
		return text
	}
}
