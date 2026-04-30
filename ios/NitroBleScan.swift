import CoreBluetooth
import Foundation
import NitroModules

private final class BleCentralDelegate: NSObject, CBCentralManagerDelegate {
  weak var owner: NitroBleScan?

  init(owner: NitroBleScan) {
    self.owner = owner
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    owner?.handleCentralStateUpdate(central)
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String : Any],
    rssi RSSI: NSNumber
  ) {
    owner?.handleDidDiscover(peripheral: peripheral, advertisementData: advertisementData, rssi: RSSI)
  }
}

class NitroBleScan: HybridNitroBleScanSpec {
  private var centralManager: CBCentralManager!
  private var centralDelegate: BleCentralDelegate!
  private var eventListener: ((String) -> Void)?
  private var isScanning = false
  private var lastStartTs: Int64 = 0
  private var lastStopTs: Int64 = 0
  private var eventsEmitted = 0
  private var eventsDropped = 0
  private var coalescedCount = 0
  private var lastErrorCode: String?
  private var coalescingWindowMs: Int64 = 150
  private var seenDevices: [String: Int64] = [:]
  private var stateLock = NSLock()

  override init() {
    super.init()
    centralDelegate = BleCentralDelegate(owner: self)
    centralManager = CBCentralManager(delegate: centralDelegate, queue: nil)
  }

  func getAdapterState() -> String {
    return adapterStateString(centralManager.state)
  }

  func ensurePermissions() -> Bool {
    if #available(iOS 13.1, *) {
      return CBManager.authorization == .allowedAlways
    }
    return true
  }

  func startScan(configJson: String) -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }

    if isScanning {
      emitIssue(type: "warning", code: "BLE_ALREADY_SCANNING", message: "Scan already running.", recoveryHint: "Call stopScan() before restarting.", platformDetails: nil)
      return true
    }
    guard ensurePermissions() else {
      emitIssue(type: "error", code: "BLE_PERMISSION_DENIED", message: "Bluetooth permissions are not granted.", recoveryHint: "Grant Bluetooth permission in Settings.", platformDetails: nil)
      return false
    }
    guard centralManager.state == .poweredOn else {
      emitIssue(type: "error", code: "BLE_ADAPTER_OFF", message: "Bluetooth adapter is not powered on.", recoveryHint: "Enable Bluetooth and retry.", platformDetails: nil)
      return false
    }

    let config = parseConfig(configJson)
    if config.enableClassicDiscovery == true {
      emitIssue(
        type: "warning",
        code: "BLE_CLASSIC_UNSUPPORTED",
        message: "Classic Bluetooth discovery is not available on iOS for third-party apps.",
        recoveryHint: "Use BLE scan on iOS, and test classic discovery on Android.",
        platformDetails: nil
      )
    }
    coalescingWindowMs = max(0, config.coalescingWindowMs ?? 150)
    seenDevices.removeAll()

    var options: [String: Any] = [CBCentralManagerScanOptionAllowDuplicatesKey: config.allowDuplicates ?? false]
    if let solicited = config.serviceUuids, !solicited.isEmpty {
      options[CBCentralManagerScanOptionSolicitedServiceUUIDsKey] = solicited
    }
    centralManager.scanForPeripherals(withServices: config.serviceUuids, options: options)
    isScanning = true
    lastStartTs = nowMs()
    emitSimpleEvent(type: "scanStarted", reason: nil)
    return true
  }

  func stopScan() -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }

    if !isScanning {
      emitIssue(type: "warning", code: "BLE_NOT_SCANNING", message: "stopScan() called while scanner is idle.", recoveryHint: "This call is safe to ignore.", platformDetails: nil)
      return true
    }
    centralManager.stopScan()
    isScanning = false
    lastStopTs = nowMs()
    emitSimpleEvent(type: "scanStopped", reason: "manualStop")
    return true
  }

  func getSnapshot() -> String {
    stateLock.lock()
    defer { stateLock.unlock() }
    var payload: [String: Any] = [
      "isScanning": isScanning,
      "adapterState": adapterStateString(centralManager.state),
      "seenDeviceCount": seenDevices.count,
      "eventsEmitted": eventsEmitted,
      "eventsDropped": eventsDropped,
      "coalescedCount": coalescedCount
    ]
    if lastStartTs > 0 { payload["lastStartTs"] = lastStartTs }
    if lastStopTs > 0 { payload["lastStopTs"] = lastStopTs }
    if let lastErrorCode { payload["lastErrorCode"] = lastErrorCode }
    return stringify(payload)
  }

  func setEventListener(listener: @escaping (String) -> Void) {
    stateLock.lock()
    eventListener = listener
    stateLock.unlock()
  }

  func handleCentralStateUpdate(_ central: CBCentralManager) {
    stateLock.lock()
    defer { stateLock.unlock() }
    emitEvent(type: "adapterStateChanged", payload: adapterStateString(central.state))
    if isScanning && central.state != .poweredOn {
      isScanning = false
      lastStopTs = nowMs()
      emitSimpleEvent(type: "scanStopped", reason: "adapterOff")
    }
  }

  func handleDidDiscover(peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
    stateLock.lock()
    defer { stateLock.unlock() }

    let id = peripheral.identifier.uuidString
    let now = nowMs()
    if let lastSeen = seenDevices[id], now - lastSeen < coalescingWindowMs {
      coalescedCount += 1
      return
    }
    seenDevices[id] = now

    var serviceUuids: [String] = []
    if let uuids = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] {
      serviceUuids = uuids.map { $0.uuidString }
    }

    let payload: [String: Any] = [
      "id": id,
      "name": peripheral.name as Any,
      "rssi": RSSI.intValue,
      "serviceUuids": serviceUuids,
      "timestampMs": now,
      "isConnectable": advertisementData[CBAdvertisementDataIsConnectable] as Any
    ]
    emitEvent(type: "deviceFound", payload: payload)
  }

  private func parseConfig(_ json: String) -> ParsedConfig {
    guard let data = json.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return ParsedConfig()
    }
    var config = ParsedConfig()
    config.allowDuplicates = obj["allowDuplicates"] as? Bool
    config.coalescingWindowMs = obj["coalescingWindowMs"] as? Int64
    config.enableClassicDiscovery = obj["enableClassicDiscovery"] as? Bool
    if let uuids = obj["serviceUuids"] as? [String] {
      config.serviceUuids = uuids.compactMap { UUID(uuidString: $0) }.map(CBUUID.init)
    }
    return config
  }

  private struct ParsedConfig {
    var allowDuplicates: Bool?
    var coalescingWindowMs: Int64?
    var enableClassicDiscovery: Bool?
    var serviceUuids: [CBUUID]?
  }

  private func emitSimpleEvent(type: String, reason: String?) {
    var event: [String: Any] = ["type": type, "ts": nowMs()]
    if let reason { event["reason"] = reason }
    emitRawEvent(event)
  }

  private func emitIssue(type: String, code: String, message: String, recoveryHint: String?, platformDetails: String?) {
    lastErrorCode = code
    var payload: [String: Any] = ["code": code, "message": message]
    if let recoveryHint { payload["recoveryHint"] = recoveryHint }
    if let platformDetails { payload["platformDetails"] = platformDetails }
    emitRawEvent(["type": type, "ts": nowMs(), "payload": payload])
  }

  private func emitEvent(type: String, payload: Any) {
    emitRawEvent(["type": type, "ts": nowMs(), "payload": payload])
  }

  private func emitRawEvent(_ event: [String: Any]) {
    guard let listener = eventListener else {
      eventsDropped += 1
      return
    }
    do {
      listener(try stringifyThrowing(event))
      eventsEmitted += 1
    } catch {
      eventsDropped += 1
    }
  }

  private func stringify(_ payload: [String: Any]) -> String {
    return (try? stringifyThrowing(payload)) ?? "{}"
  }

  private func stringifyThrowing(_ payload: [String: Any]) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: payload, options: [])
    return String(data: data, encoding: .utf8) ?? "{}"
  }

  private func adapterStateString(_ state: CBManagerState) -> String {
    switch state {
    case .poweredOn: return "poweredOn"
    case .poweredOff: return "poweredOff"
    case .unauthorized: return "unauthorized"
    case .unsupported: return "unsupported"
    case .resetting: return "resetting"
    default: return "unknown"
    }
  }

  private func nowMs() -> Int64 {
    return Int64(Date().timeIntervalSince1970 * 1000)
  }
}
