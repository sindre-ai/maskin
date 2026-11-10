import Foundation

/// The data seam for a loop's custom view, the native counterpart of `apps/web/src/lib/loop-view-bridge.ts`.
///
/// A view is an ordinary HTML page under the platform's locked-down policy. It gets numbers only by
/// asking the host through `window.maskin.query(name)`; the host answers from the viewer's own
/// session and the page only ever receives the result. A view declares what it may ask for in
/// `<script id="maskin-sources" type="application/json">`: a map of source name to query. The host
/// answers declared names only, so a page cannot ask for anything it did not state up front.
public enum LoopViewBridge {
	/// The one script message handler the page can post to.
	public static let handlerName = "maskin"
	public static let sourcesSlotID = "maskin-sources"

	/// Page to host: `{ type, id, name }`.
	public static let queryMessage = "maskin:bridge:query"
	/// Page to host: `{ type, w, cw, h }`, the content size.
	public static let sizeMessage = "maskin:viewer:doc-size"

	/// Most queries answered at once; a page that floods past it gets errors back.
	public static let maxInFlight = 16

	// MARK: Messages

	public enum Message: Equatable, Sendable {
		case query(id: Int, name: String)
		case size(height: Double, width: Double?, clientWidth: Double?)
	}

	/// Reads what a page posted. Anything that is not exactly one of the two shapes is ignored.
	public static func parse(_ body: Any) -> Message? {
		guard let dict = body as? [String: Any], let type = dict["type"] as? String else { return nil }
		switch type {
		case queryMessage:
			guard let id = integer(dict["id"]), let name = dict["name"] as? String else { return nil }
			return .query(id: id, name: name)
		case sizeMessage:
			guard let h = number(dict["h"]), h > 0 else { return nil }
			return .size(height: h, width: number(dict["w"]), clientWidth: number(dict["cw"]))
		default:
			return nil
		}
	}

	private static func number(_ value: Any?) -> Double? {
		guard let n = value as? NSNumber else { return nil }
		let d = n.doubleValue
		return d.isFinite ? d : nil
	}

	private static func integer(_ value: Any?) -> Int? {
		guard let d = number(value), d.rounded() == d, abs(d) < 1e15 else { return nil }
		return Int(d)
	}

	// MARK: Answers

	public enum Reply: Equatable, Sendable {
		case data(JSONValue)
		case error(String)
	}

	/// Answers one query message: the declared source's query run as the viewer, or an error for a
	/// name that was never declared. Never throws; a failed query becomes an error reply.
	public static func answer(
		name: String, sources: [String: JSONValue],
		run: @Sendable (JSONValue) async throws -> JSONValue
	) async -> Reply {
		guard let spec = sources[name] else {
			return .error("Source \"\(name)\" is not declared in the \(sourcesSlotID) block.")
		}
		do {
			return .data(try await run(spec))
		} catch {
			return .error((error as? LoopViewError)?.message ?? "The query failed.")
		}
	}

	// MARK: Declared sources

	public enum SourcesResult: Equatable, Sendable {
		case ok([String: JSONValue])
		case invalid(String)
	}

	private static let sourcesPattern =
		#"<script\b[^>]*\bid\s*=\s*["']?maskin-sources["']?[^>]*>(.*?)</script\s*>"#

	/// The sources a view declares. A missing block is a valid view with no data; malformed JSON, a
	/// block that is not an object, or a source that is not an object is an error the tab shows.
	/// The server checks each query's fields when it runs it.
	public static func readSources(from html: String) -> SourcesResult {
		let regex = try? NSRegularExpression(
			pattern: sourcesPattern, options: [.caseInsensitive, .dotMatchesLineSeparators])
		guard
			let match = regex?.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)),
			let slot = Range(match.range(at: 1), in: html)
		else { return .ok([:]) }
		let body = String(html[slot])
		guard let data = body.data(using: .utf8),
			let raw = try? JSONDecoder().decode(JSONValue.self, from: data)
		else { return .invalid("The \(sourcesSlotID) block is not valid JSON.") }
		guard case .object(let entries) = raw else {
			return .invalid("The \(sourcesSlotID) block must be a JSON object.")
		}
		for (name, value) in entries {
			guard case .object = value else {
				return .invalid("Source \"\(name)\" is not a valid query.")
			}
		}
		return .ok(entries)
	}

	/// A query as compact JSON with sorted keys: the same spec always gives the same text, so it
	/// can key an answer and go in the request as it is.
	public static func canonical(_ spec: JSONValue) -> String {
		let encoder = JSONEncoder()
		encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
		return (try? encoder.encode(spec)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
	}
}

/// A failure the page may be told about, in words a person can read.
public struct LoopViewError: Error, Equatable, Sendable, LocalizedError {
	public let message: String
	public init(_ message: String) { self.message = message }
	public var errorDescription: String? { message }
}
