import SwiftUI
import HealthKit
import Combine

@MainActor
final class HealthManager: ObservableObject {
    struct HealthRow: Identifiable {
        let id = UUID()
        let title: String
        var value: String
        var time: String
    }

    private struct QuantityMetric {
        let title: String
        let identifier: HKQuantityTypeIdentifier
        let unit: HKUnit
        let format: (Double) -> String
    }

    @Published var statusText = "准备请求健康数据权限"
    @Published var rows: [HealthRow] = []
    @Published var shareText = "还没有健康数据，请先读取。"

    private let healthStore = HKHealthStore()
    private var observerQueries: [HKObserverQuery] = []

    private let quantityMetrics: [QuantityMetric] = [
        QuantityMetric(title: "心率", identifier: .heartRate, unit: HKUnit.count().unitDivided(by: .minute())) { "\(Int($0.rounded())) BPM" },
        QuantityMetric(title: "静息心率", identifier: .restingHeartRate, unit: HKUnit.count().unitDivided(by: .minute())) { "\(Int($0.rounded())) BPM" },
        QuantityMetric(title: "步行平均心率", identifier: .walkingHeartRateAverage, unit: HKUnit.count().unitDivided(by: .minute())) { "\(Int($0.rounded())) BPM" },
        QuantityMetric(title: "心率变异性 HRV", identifier: .heartRateVariabilitySDNN, unit: HKUnit.secondUnit(with: .milli)) { "\(Int($0.rounded())) ms" },
        QuantityMetric(title: "血氧", identifier: .oxygenSaturation, unit: .percent()) { "\(Int(($0 * 100).rounded()))%" },
        QuantityMetric(title: "呼吸频率", identifier: .respiratoryRate, unit: HKUnit.count().unitDivided(by: .minute())) { "\(Int($0.rounded())) 次/分钟" },
        QuantityMetric(title: "步数", identifier: .stepCount, unit: .count()) { "\(Int($0.rounded())) 步" },
        QuantityMetric(title: "步行/跑步距离", identifier: .distanceWalkingRunning, unit: .meter()) { String(format: "%.2f km", $0 / 1000) },
        QuantityMetric(title: "活动能量", identifier: .activeEnergyBurned, unit: .kilocalorie()) { "\(Int($0.rounded())) kcal" },
        QuantityMetric(title: "基础能量", identifier: .basalEnergyBurned, unit: .kilocalorie()) { "\(Int($0.rounded())) kcal" },
        QuantityMetric(title: "站立时间", identifier: .appleStandTime, unit: .minute()) { "\(Int($0.rounded())) 分钟" },
        QuantityMetric(title: "锻炼时间", identifier: .appleExerciseTime, unit: .minute()) { "\(Int($0.rounded())) 分钟" },
        QuantityMetric(title: "环境噪音暴露", identifier: .environmentalAudioExposure, unit: HKUnit.decibelAWeightedSoundPressureLevel()) { String(format: "%.1f dB", $0) },
        QuantityMetric(title: "耳机音量暴露", identifier: .headphoneAudioExposure, unit: HKUnit.decibelAWeightedSoundPressureLevel()) { String(format: "%.1f dB", $0) },
        QuantityMetric(title: "最大摄氧量 VO2 Max", identifier: .vo2Max, unit: HKUnit(from: "ml/kg*min")) { String(format: "%.1f ml/kg/min", $0) },
        QuantityMetric(title: "步行速度", identifier: .walkingSpeed, unit: HKUnit.meter().unitDivided(by: .second())) { String(format: "%.2f m/s", $0) },
        QuantityMetric(title: "步长", identifier: .walkingStepLength, unit: .meter()) { "\(Int(($0 * 100).rounded())) cm" },
        QuantityMetric(title: "六分钟步行距离", identifier: .sixMinuteWalkTestDistance, unit: .meter()) { "\(Int($0.rounded())) m" }
    ]

    init() {
        setupBackgroundObservers()
    }

    func requestPermissionAndReadAll() {
        guard HKHealthStore.isHealthDataAvailable() else {
            statusText = "这台设备不支持 HealthKit"
            return
        }

        let quantityTypes = quantityMetrics.compactMap { HKQuantityType.quantityType(forIdentifier: $0.identifier) }
        let categoryTypes = [HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)].compactMap { $0 }
        let readTypes = Set<HKObjectType>(quantityTypes + categoryTypes)

        healthStore.requestAuthorization(toShare: [], read: readTypes) { [weak self] success, error in
            DispatchQueue.main.async {
                if let error {
                    self?.statusText = "授权失败：\(error.localizedDescription)"
                    return
                }

                guard success else {
                    self?.statusText = "没有获得健康数据读取权限"
                    return
                }

                self?.statusText = "已获得权限，正在读取 Apple Watch/健康数据"
                self?.setupBackgroundObservers()
                self?.readLatestValues()
            }
        }
    }

    private func readLatestValues() {
        rows = []

        for metric in quantityMetrics {
            guard let type = HKQuantityType.quantityType(forIdentifier: metric.identifier) else { continue }
            readLatestQuantity(metric, type: type)
        }

        if let sleepType = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis) {
            readLatestSleep(sleepType)
        }
    }

    private func readLatestQuantity(_ metric: QuantityMetric, type: HKQuantityType) {
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
        let query = HKSampleQuery(
            sampleType: type,
            predicate: nil,
            limit: 1,
            sortDescriptors: [sort]
        ) { [weak self] _, samples, error in
            DispatchQueue.main.async {
                if let error {
                    self?.upsertRow(title: metric.title, value: "读取失败", time: error.localizedDescription)
                    return
                }

                guard let sample = samples?.first as? HKQuantitySample else {
                    self?.upsertRow(title: metric.title, value: "暂无记录", time: "健康 App 里还没有这项数据")
                    return
                }

                let value = sample.quantity.doubleValue(for: metric.unit)
                let time = sample.endDate.formatted(date: .abbreviated, time: .shortened)
                let displayValue = metric.format(value)
                self?.upsertRow(title: metric.title, value: displayValue, time: time)
                self?.uploadQuantity(metric, value: value, displayValue: displayValue, sample: sample)
                self?.refreshShareText()
                self?.statusText = "读取完成"
            }
        }

        healthStore.execute(query)
    }

    private func readLatestSleep(_ type: HKCategoryType) {
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
        let query = HKSampleQuery(
            sampleType: type,
            predicate: nil,
            limit: 1,
            sortDescriptors: [sort]
        ) { [weak self] _, samples, error in
            DispatchQueue.main.async {
                if let error {
                    self?.upsertRow(title: "睡眠", value: "读取失败", time: error.localizedDescription)
                    return
                }

                guard let sample = samples?.first as? HKCategorySample else {
                    self?.upsertRow(title: "睡眠", value: "暂无记录", time: "健康 App 里还没有睡眠数据")
                    return
                }

                let minutes = Int(sample.endDate.timeIntervalSince(sample.startDate) / 60)
                let time = "\(sample.startDate.formatted(date: .abbreviated, time: .shortened)) - \(sample.endDate.formatted(date: .omitted, time: .shortened))"
                self?.upsertRow(title: "睡眠", value: "\(minutes) 分钟", time: time)
                self?.uploadMetric(
                    key: "sleep",
                    value: minutes,
                    unit: "min",
                    displayValue: "\(minutes) 分钟",
                    sampledAt: sample.endDate,
                    source: sample.sourceRevision.source.name,
                    extra: ["started_at": ISO8601DateFormatter().string(from: sample.startDate)]
                )
                self?.refreshShareText()
                self?.statusText = "读取完成"
            }
        }

        healthStore.execute(query)
    }

    private func upsertRow(title: String, value: String, time: String) {
        if let index = rows.firstIndex(where: { $0.title == title }) {
            rows[index] = HealthRow(title: title, value: value, time: time)
        } else {
            rows.append(HealthRow(title: title, value: value, time: time))
        }
    }

    private func setupBackgroundObservers() {
        guard observerQueries.isEmpty else { return }

        let quantityTypes = quantityMetrics.compactMap { HKQuantityType.quantityType(forIdentifier: $0.identifier) }
        let sleepTypes = [HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)].compactMap { $0 }
        let sampleTypes: [HKSampleType] = quantityTypes + sleepTypes

        for type in sampleTypes {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, error in
                guard error == nil else {
                    completion()
                    return
                }
                Task { @MainActor in
                    self?.syncLatestSample(for: type, completion: completion)
                }
            }
            observerQueries.append(query)
            healthStore.execute(query)
            healthStore.enableBackgroundDelivery(for: type, frequency: .immediate) { _, _ in }
        }
    }

    private func syncLatestSample(for type: HKSampleType, completion: @escaping () -> Void) {
        if let quantityType = type as? HKQuantityType,
           let metric = quantityMetrics.first(where: { $0.identifier.rawValue == quantityType.identifier }) {
            readLatestQuantity(metric, type: quantityType)
        } else if let sleepType = type as? HKCategoryType,
                  sleepType.identifier == HKCategoryTypeIdentifier.sleepAnalysis.rawValue {
            readLatestSleep(sleepType)
        }
        completion()
    }

    private func uploadQuantity(
        _ metric: QuantityMetric,
        value: Double,
        displayValue: String,
        sample: HKQuantitySample
    ) {
        let relayValue = normalizedRelayValue(value, identifier: metric.identifier)
        uploadMetric(
            key: relayKey(for: metric.identifier),
            value: relayValue,
            unit: relayUnit(for: metric.identifier),
            displayValue: displayValue,
            sampledAt: sample.endDate,
            source: sample.sourceRevision.source.name
        )
    }

    private func uploadMetric(
        key: String,
        value: Any,
        unit: String,
        displayValue: String,
        sampledAt: Date,
        source: String,
        extra: [String: Any] = [:]
    ) {
        guard let config = RelayConfiguration.load(),
              let url = URL(string: config.baseURL + "/upload") else { return }
        let sampledAtText = ISO8601DateFormatter().string(from: sampledAt)
        var metric: [String: Any] = [
            "value": value,
            "unit": unit,
            "display_value": displayValue,
            "sampled_at": sampledAtText,
            "source_device": source,
        ]
        metric.merge(extra) { _, new in new }

        let payload: [String: Any] = [
            "sampled_at": sampledAtText,
            "device": "iPhone HealthKit",
            "metrics": [key: metric],
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(config.uploadToken)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request).resume()
    }

    private func normalizedRelayValue(_ value: Double, identifier: HKQuantityTypeIdentifier) -> Double {
        switch identifier {
        case .oxygenSaturation: value * 100
        case .distanceWalkingRunning: value / 1000
        case .walkingStepLength: value * 100
        default: value
        }
    }

    private func relayKey(for identifier: HKQuantityTypeIdentifier) -> String {
        switch identifier {
        case .heartRate: "heart_rate"
        case .restingHeartRate: "resting_heart_rate"
        case .walkingHeartRateAverage: "walking_heart_rate_average"
        case .heartRateVariabilitySDNN: "hrv_sdnn"
        case .oxygenSaturation: "oxygen_saturation"
        case .respiratoryRate: "respiratory_rate"
        case .stepCount: "step_count"
        case .distanceWalkingRunning: "walking_running_distance"
        case .activeEnergyBurned: "active_energy"
        case .basalEnergyBurned: "basal_energy"
        case .appleStandTime: "stand_time"
        case .appleExerciseTime: "exercise_time"
        case .environmentalAudioExposure: "environmental_audio_exposure"
        case .headphoneAudioExposure: "headphone_audio_exposure"
        case .vo2Max: "vo2_max"
        case .walkingSpeed: "walking_speed"
        case .walkingStepLength: "walking_step_length"
        case .sixMinuteWalkTestDistance: "six_minute_walk_distance"
        default: identifier.rawValue
        }
    }

    private func relayUnit(for identifier: HKQuantityTypeIdentifier) -> String {
        switch identifier {
        case .heartRate, .restingHeartRate, .walkingHeartRateAverage: "BPM"
        case .heartRateVariabilitySDNN: "ms"
        case .oxygenSaturation: "%"
        case .respiratoryRate: "breaths/min"
        case .stepCount: "count"
        case .distanceWalkingRunning: "km"
        case .activeEnergyBurned, .basalEnergyBurned: "kcal"
        case .appleStandTime, .appleExerciseTime: "min"
        case .environmentalAudioExposure, .headphoneAudioExposure: "dB(A)"
        case .vo2Max: "ml/kg/min"
        case .walkingSpeed: "m/s"
        case .walkingStepLength: "cm"
        case .sixMinuteWalkTestDistance: "m"
        default: ""
        }
    }

    func copySummary() {
        refreshShareText()
        UIPasteboard.general.string = shareText
        statusText = "健康摘要已复制"
    }

    private func refreshShareText() {
        let validRows = rows.filter { $0.value != "暂无记录" && $0.value != "读取失败" }

        guard !validRows.isEmpty else {
            shareText = "还没有可分享的健康数据。"
            return
        }

        var lines = [
            "Apple Watch 健康数据摘要",
            "生成时间：\(Date().formatted(date: .abbreviated, time: .shortened))",
            ""
        ]

        lines += validRows.map { "\($0.title)：\($0.value)（\($0.time)）" }
        shareText = lines.joined(separator: "\n")
    }
}

struct ContentView: View {
    @StateObject private var healthManager = HealthManager()

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 14) {
                        Image(systemName: "heart.text.square.fill")
                            .font(.system(size: 48))
                            .foregroundStyle(.red)

                        Text("Apple Watch 健康数据")
                            .font(.title)
                            .fontWeight(.semibold)

                        Text(healthManager.statusText)
                            .foregroundStyle(.secondary)

                        Button("请求权限并读取全部") {
                            healthManager.requestPermissionAndReadAll()
                        }
                        .buttonStyle(.borderedProminent)

                        HStack {
                            Button("复制摘要") {
                                healthManager.copySummary()
                            }
                            .buttonStyle(.bordered)

                            ShareLink(item: healthManager.shareText) {
                                Label("分享给 G 老师", systemImage: "square.and.arrow.up")
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(.vertical, 8)
                }

                Section("最近一次记录") {
                    ForEach(healthManager.rows) { row in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.title)
                                .font(.headline)
                            Text(row.value)
                                .font(.title3)
                                .fontWeight(.medium)
                            Text(row.time)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .navigationTitle("健康读取测试")
        }
    }
}

#Preview {
    ContentView()
}
