import Foundation

struct RelayConfiguration {
    let baseURL: String
    let uploadToken: String

    static func load(bundle: Bundle = .main) -> RelayConfiguration? {
        guard let url = bundle.url(forResource: "RelayConfig", withExtension: "plist"),
              let data = try? Data(contentsOf: url),
              let values = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let rawBaseURL = values["BaseURL"] as? String,
              let uploadToken = values["UploadToken"] as? String else {
            return nil
        }

        let baseURL = rawBaseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard baseURL.hasPrefix("https://"),
              !baseURL.contains("example.com"),
              uploadToken.count >= 32,
              uploadToken != "REPLACE_WITH_RANDOM_UPLOAD_TOKEN" else {
            return nil
        }

        return RelayConfiguration(baseURL: baseURL, uploadToken: uploadToken)
    }
}
