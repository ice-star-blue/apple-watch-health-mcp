import SwiftUI
import HealthKit
import Combine

@MainActor
final class LiveHealthManager: NSObject, ObservableObject {
    @Published var isRunning = false
    @Published var heartRate: Double?
    @Published var lastSampleTime: Date?
    @Published var status = "准备开始实时测量"
    @Published var relayStatus = "尚未连接 G 老师"

    private let healthStore = HKHealthStore()
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?

    func start() {
        guard HKHealthStore.isHealthDataAvailable() else {
            status = "这只手表不支持 HealthKit"
            return
        }

        guard let heartRateType = HKQuantityType.quantityType(forIdentifier: .heartRate) else {
            status = "无法使用心率数据"
            return
        }

        let readTypes: Set<HKObjectType> = [heartRateType]
        let shareTypes: Set<HKSampleType> = [HKObjectType.workoutType()]

        healthStore.requestAuthorization(toShare: shareTypes, read: readTypes) { [weak self] success, error in
            Task { @MainActor in
                if let error {
                    self?.status = "授权失败：\(error.localizedDescription)"
                    return
                }
                guard success else {
                    self?.status = "没有获得健康权限"
                    return
                }
                self?.beginLiveSession()
            }
        }
    }

    func stop() {
        guard let session else { return }
        status = "正在停止"
        session.end()
    }

    private func beginLiveSession() {
        guard !isRunning else { return }

        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .other
        configuration.locationType = .unknown

        do {
            let session = try HKWorkoutSession(healthStore: healthStore, configuration: configuration)
            let builder = session.associatedWorkoutBuilder()
            builder.dataSource = HKLiveWorkoutDataSource(healthStore: healthStore, workoutConfiguration: configuration)
            session.delegate = self
            builder.delegate = self

            self.session = session
            self.builder = builder

            let startDate = Date()
            session.startActivity(with: startDate)
            builder.beginCollection(withStart: startDate) { [weak self] success, error in
                Task { @MainActor in
                    if let error {
                        self?.status = "启动失败：\(error.localizedDescription)"
                    } else if success {
                        self?.isRunning = true
                        self?.status = "实时测量中"
                        self?.uploadHeartbeat()
                    }
                }
            }
        } catch {
            status = "无法启动：\(error.localizedDescription)"
        }
    }

    private func receivedHeartRate(_ value: Double, sampledAt: Date) {
        heartRate = value
        lastSampleTime = sampledAt
        status = "实时测量中"
        upload(value: value, sampledAt: sampledAt, liveMode: true)
    }

    private func uploadHeartbeat() {
        upload(value: heartRate, sampledAt: lastSampleTime ?? Date(), liveMode: true)
    }

    private func upload(value: Double?, sampledAt: Date, liveMode: Bool) {
        guard let config = RelayConfiguration.load(),
              let url = URL(string: config.baseURL + "/upload") else {
            relayStatus = "等待配置 Cloudflare"
            return
        }

        var metrics: [String: Any] = [:]
        if let value {
            metrics["heart_rate"] = [
                "value": Int(value.rounded()),
                "unit": "BPM",
                "sampled_at": ISO8601DateFormatter().string(from: sampledAt),
                "source_device": "Apple Watch live mode",
            ]
        }

        let payload: [String: Any] = [
            "sampled_at": ISO8601DateFormatter().string(from: sampledAt),
            "live_mode": liveMode,
            "device": "Apple Watch",
            "metrics": metrics,
        ]

        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(config.uploadToken)", forHTTPHeaderField: "Authorization")

        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            Task { @MainActor in
                if let error {
                    self?.relayStatus = "上传失败：\(error.localizedDescription)"
                } else if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self?.relayStatus = "已同步给 G 老师"
                } else {
                    self?.relayStatus = "服务器未接受数据"
                }
            }
        }.resume()
    }

    private func finishSession(at endDate: Date) {
        guard let builder else {
            resetAfterStop()
            return
        }

        builder.endCollection(withEnd: endDate) { [weak self] _, _ in
            builder.discardWorkout()
            Task { @MainActor in
                self?.resetAfterStop()
            }
        }
    }

    private func resetAfterStop() {
        upload(value: heartRate, sampledAt: lastSampleTime ?? Date(), liveMode: false)
        isRunning = false
        status = "实时测量已停止"
        session = nil
        builder = nil
    }
}

extension LiveHealthManager: HKWorkoutSessionDelegate, HKLiveWorkoutBuilderDelegate {
    nonisolated func workoutSession(
        _ workoutSession: HKWorkoutSession,
        didChangeTo toState: HKWorkoutSessionState,
        from fromState: HKWorkoutSessionState,
        date: Date
    ) {
        guard toState == .ended else { return }
        Task { @MainActor [weak self] in
            self?.finishSession(at: date)
        }
    }

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        Task { @MainActor [weak self] in
            self?.status = "测量中断：\(error.localizedDescription)"
            self?.resetAfterStop()
        }
    }

    nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}

    nonisolated func workoutBuilder(
        _ workoutBuilder: HKLiveWorkoutBuilder,
        didCollectDataOf collectedTypes: Set<HKSampleType>
    ) {
        guard let heartRateType = HKQuantityType.quantityType(forIdentifier: .heartRate),
              collectedTypes.contains(heartRateType),
              let statistics = workoutBuilder.statistics(for: heartRateType),
              let quantity = statistics.mostRecentQuantity() else { return }

        let unit = HKUnit.count().unitDivided(by: .minute())
        let value = quantity.doubleValue(for: unit)
        let sampleTime = statistics.endDate

        Task { @MainActor [weak self] in
            self?.receivedHeartRate(value, sampledAt: sampleTime)
        }
    }
}

struct ContentView: View {
    @StateObject private var manager = LiveHealthManager()

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Image(systemName: manager.isRunning ? "heart.fill" : "heart")
                    .font(.system(size: 34))
                    .foregroundStyle(.red)
                    .symbolEffect(.pulse, isActive: manager.isRunning)

                if let heartRate = manager.heartRate {
                    Text("\(Int(heartRate.rounded()))")
                        .font(.system(size: 42, weight: .semibold, design: .rounded))
                    Text("BPM")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("-- BPM")
                        .font(.title2)
                }

                Text(manager.status)
                    .font(.footnote)
                    .multilineTextAlignment(.center)

                Text(manager.relayStatus)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                if manager.isRunning {
                    Button(role: .destructive) {
                        manager.stop()
                    } label: {
                        Label("停止", systemImage: "stop.fill")
                    }
                } else {
                    Button {
                        manager.start()
                    } label: {
                        Label("开始实时模式", systemImage: "waveform.path.ecg")
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .padding(.horizontal, 8)
        }
    }
}

#Preview {
    ContentView()
}
