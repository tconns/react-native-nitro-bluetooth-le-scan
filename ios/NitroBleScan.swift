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

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    owner?.handleDidConnect(peripheral: peripheral)
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    owner?.handleDidFailToConnect(peripheral: peripheral, error: error)
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    owner?.handleDidDisconnect(peripheral: peripheral, error: error)
  }
}

private final class BlePeripheralDelegate: NSObject, CBPeripheralDelegate {
  weak var owner: NitroBleScan?

  init(owner: NitroBleScan) {
    self.owner = owner
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    owner?.handlePeripheralDidDiscoverServices(peripheral: peripheral, error: error)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    owner?.handlePeripheralDidUpdateValue(peripheral: peripheral, characteristic: characteristic, error: error)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didWriteValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    owner?.handlePeripheralDidWriteValue(peripheral: peripheral, characteristic: characteristic, error: error)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    owner?.handlePeripheralDidUpdateNotificationState(peripheral: peripheral, characteristic: characteristic, error: error)
  }
}

class NitroBleScan: HybridNitroBleScanSpec {
  private var centralManager: CBCentralManager!
  private var centralDelegate: BleCentralDelegate!
  private var peripheralDelegate: BlePeripheralDelegate!
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
  private var rssiHistory: [String: [Int]] = [:]
  private var dedupeMode = "deviceId"
  private var rssiSmoothingWindow = 5
  private var rankingWeights = RankingWeights()
  private var discoveredPeripherals: [String: CBPeripheral] = [:]
  private var connectedPeripherals: [String: CBPeripheral] = [:]
  private var connectionStateById: [String: String] = [:]
  private var serviceCache: [String: String] = [:]
  private var pendingGattByRequestId: [String: PendingGattRequest] = [:]
  private var pendingTimeoutByRequestId: [String: DispatchWorkItem] = [:]
  private var pendingDiscoverRequestByDeviceId: [String: String] = [:]
  private var pendingReadRequestByKey: [String: String] = [:]
  private var pendingWriteRequestByKey: [String: String] = [:]
  private var pendingNotifyRequestByKey: [String: String] = [:]
  private var stateLock = NSLock()
  private var isDisposed = false
  private var discoverOrder: [String] = []
  private let maxTrackedPeripherals = 256
  private let maxTrackedSeenDevices = 512

  private struct RankingWeights {
    var rssi = 0.6
    var recency = 0.25
    var connectable = 0.1
    var transport = 0.05
  }

  private struct PendingGattRequest {
    let requestId: String
    let opName: String
    let deviceId: String
    let addressKey: String?
  }

  private struct GattOperationRequest {
    let requestId: String
    let opName: String
    let deviceId: String
    let address: CharacteristicAddress?
    let value: [UInt8]?
    let enable: Bool?
    let timeoutMs: Int64
  }

  override init() {
    super.init()
    centralDelegate = BleCentralDelegate(owner: self)
    peripheralDelegate = BlePeripheralDelegate(owner: self)
    centralManager = CBCentralManager(delegate: centralDelegate, queue: nil)
  }

  deinit {
    stateLock.lock()
    cleanupResourcesLocked()
    stateLock.unlock()
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

  func setBluetoothEnabled(enable: Bool) -> Bool {
    emitIssue(
      type: "warning",
      code: "BLE_ADAPTER_TOGGLE_UNSUPPORTED",
      message: "Programmatic Bluetooth toggle is not supported on iOS third-party apps.",
      recoveryHint: "Use iOS Settings or Control Center to change Bluetooth state.",
      platformDetails: "requested=\(enable)"
    )
    return false
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
    coalescingWindowMs = max(0, config.coalescingWindowMs ?? 150)
    dedupeMode = config.dedupeMode ?? "deviceId"
    rssiSmoothingWindow = min(max(config.rssiSmoothingWindow ?? 5, 1), 20)
    rankingWeights = config.rankingWeights ?? RankingWeights()
    seenDevices.removeAll()
    rssiHistory.removeAll()
    discoveredPeripherals.removeAll()
    discoverOrder.removeAll()

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
    seenDevices.removeAll()
    rssiHistory.removeAll()
    discoveredPeripherals.removeAll()
    discoverOrder.removeAll()
    emitSimpleEvent(type: "scanStopped", reason: "manualStop")
    return true
  }

  func connect(deviceId: String, optionsJson: String) -> Bool {
    stateLock.lock()
    let peripheral = discoveredPeripherals[deviceId] ?? connectedPeripherals[deviceId]
    let currentState = connectionStateById[deviceId]
    stateLock.unlock()
    guard let peripheral else {
      emitIssue(
        type: "error",
        code: "BLE_CONNECT_DEVICE_NOT_FOUND",
        message: "Peripheral not found in discovered cache.",
        recoveryHint: "Scan first, then connect.",
        platformDetails: "deviceId=\(deviceId)"
      )
      return false
    }
    if currentState == "connecting" || currentState == "connected" {
      emitIssue(
        type: "warning",
        code: "BLE_CONNECT_IN_PROGRESS",
        message: "Connect already in progress.",
        recoveryHint: "Wait for connection event.",
        platformDetails: "deviceId=\(deviceId)"
      )
      return true
    }
    peripheral.delegate = peripheralDelegate
    let timeoutMs = parseLong(optionsJson, key: "timeoutMs", fallback: 10000)
    stateLock.lock()
    connectionStateById[deviceId] = "connecting"
    emitEvent(type: "connectionStateChanged", payload: ["deviceId": deviceId, "state": "connecting"])
    stateLock.unlock()
    centralManager.connect(peripheral, options: nil)
    DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + .milliseconds(Int(timeoutMs))) { [weak self] in
      guard let self else { return }
      self.stateLock.lock()
      defer { self.stateLock.unlock() }
      guard self.connectionStateById[deviceId] == "connecting" else { return }
      self.clearDeviceState(deviceId: deviceId)
      self.connectionStateById[deviceId] = "disconnected"
      self.centralManager.cancelPeripheralConnection(peripheral)
      self.emitEvent(type: "connectionStateChanged", payload: ["deviceId": deviceId, "state": "disconnected"])
      self.emitIssue(
        type: "error",
        code: "BLE_CONNECT_TIMEOUT",
        message: "Connect timed out.",
        recoveryHint: "Retry or move closer to peripheral.",
        platformDetails: "deviceId=\(deviceId)"
      )
    }
    return true
  }

  func disconnect(deviceId: String) -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    guard let peripheral = connectedPeripherals[deviceId] else { return true }
    connectionStateById[deviceId] = "disconnecting"
    emitEvent(type: "connectionStateChanged", payload: ["deviceId": deviceId, "state": "disconnecting"])
    centralManager.cancelPeripheralConnection(peripheral)
    return true
  }

  func submitGattOperation(operationJson: String) -> Bool {
    guard let op = parseGattOperation(operationJson) else { return false }
    stateLock.lock()
    guard let peripheral = connectedPeripherals[op.deviceId] else {
      stateLock.unlock()
      return false
    }
    if pendingGattByRequestId[op.requestId] != nil {
      stateLock.unlock()
      return false
    }
    let timeoutMs = max(1000, min(30000, op.timeoutMs))
    var started = false
    switch op.opName {
    case "discoverServices":
      pendingDiscoverRequestByDeviceId[op.deviceId] = op.requestId
      peripheral.discoverServices(nil)
      started = true
    case "readCharacteristic":
      guard let address = op.address,
            let characteristic = findCharacteristic(peripheral: peripheral, address: address)
      else {
        stateLock.unlock()
        return false
      }
      pendingReadRequestByKey[characteristicKey(address)] = op.requestId
      peripheral.readValue(for: characteristic)
      started = true
    case "writeCharacteristic":
      guard let address = op.address,
            let characteristic = findCharacteristic(peripheral: peripheral, address: address)
      else {
        stateLock.unlock()
        return false
      }
      pendingWriteRequestByKey[characteristicKey(address)] = op.requestId
      peripheral.writeValue(Data(op.value ?? []), for: characteristic, type: .withResponse)
      started = true
    case "setCharacteristicNotification":
      guard let address = op.address,
            let characteristic = findCharacteristic(peripheral: peripheral, address: address)
      else {
        stateLock.unlock()
        return false
      }
      pendingNotifyRequestByKey[characteristicKey(address)] = op.requestId
      peripheral.setNotifyValue(op.enable == true, for: characteristic)
      started = true
    default:
      started = false
    }
    if !started {
      stateLock.unlock()
      return false
    }
    let pending = PendingGattRequest(
      requestId: op.requestId,
      opName: op.opName,
      deviceId: op.deviceId,
      addressKey: op.address.map(characteristicKey)
    )
    pendingGattByRequestId[op.requestId] = pending
    let timeoutWork = DispatchWorkItem { [weak self] in
      self?.stateLock.lock()
      defer { self?.stateLock.unlock() }
      self?.completePendingRequest(
        requestId: op.requestId,
        success: false,
        errorCode: "BLE_GATT_OPERATION_TIMEOUT",
        errorMessage: "\(op.opName) timed out for \(op.deviceId)",
        payload: nil
      )
    }
    pendingTimeoutByRequestId[op.requestId] = timeoutWork
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(timeoutMs)), execute: timeoutWork)
    stateLock.unlock()
    return true
  }

  func getSnapshot() -> String {
    stateLock.lock()
    defer { stateLock.unlock() }
    var payload: [String: Any] = [
      "isScanning": isScanning,
      "adapterState": adapterStateString(centralManager.state),
      "supportsClassicDiscovery": false,
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
    discoveredPeripherals[id] = peripheral
    discoverOrder.removeAll { $0 == id }
    discoverOrder.append(id)
    if discoverOrder.count > maxTrackedPeripherals {
      let overflow = discoverOrder.prefix(discoverOrder.count - maxTrackedPeripherals)
      overflow.forEach { stale in
        discoveredPeripherals.removeValue(forKey: stale)
      }
      discoverOrder = Array(discoverOrder.suffix(maxTrackedPeripherals))
    }
    let now = nowMs()
    let manufacturerData = (advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data) ?? Data()
    let serviceUuids = ((advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []).map { $0.uuidString }
    let fingerprint = buildFingerprint(id: id, manufacturerData: manufacturerData, serviceUuids: serviceUuids)
    let dedupeKey = dedupeMode == "fingerprint" ? fingerprint : id
    if let lastSeen = seenDevices[dedupeKey], now - lastSeen < coalescingWindowMs {
      coalescedCount += 1
      return
    }
    seenDevices[dedupeKey] = now
    if seenDevices.count > maxTrackedSeenDevices {
      let oldest = seenDevices.sorted { $0.value < $1.value }.prefix(seenDevices.count - maxTrackedSeenDevices)
      oldest.forEach { entry in
        seenDevices.removeValue(forKey: entry.key)
      }
    }
    let smoothedRssi = smoothRssi(deviceId: id, rssi: RSSI.intValue)
    let score = calculateScore(
      rssi: smoothedRssi,
      isConnectable: (advertisementData[CBAdvertisementDataIsConnectable] as? Bool) ?? false,
      transport: "ble",
      seenAt: now
    )

    let payload: [String: Any] = [
      "id": id,
      "transport": "ble",
      "name": peripheral.name as Any,
      "rssi": RSSI.intValue,
      "smoothedRssi": smoothedRssi,
      "score": score,
      "fingerprint": fingerprint,
      "manufacturerData": manufacturerData.map { Int($0) },
      "serviceUuids": serviceUuids,
      "timestampMs": now,
      "isConnectable": advertisementData[CBAdvertisementDataIsConnectable] as Any
    ]
    emitEvent(type: "deviceFound", payload: payload)
  }

  func handleDidConnect(peripheral: CBPeripheral) {
    stateLock.lock()
    defer { stateLock.unlock() }
    let id = peripheral.identifier.uuidString
    peripheral.delegate = peripheralDelegate
    connectedPeripherals[id] = peripheral
    connectionStateById[id] = "connected"
    emitEvent(type: "connectionStateChanged", payload: ["deviceId": id, "state": "connected"])
  }

  func handleDidFailToConnect(peripheral: CBPeripheral, error: Error?) {
    stateLock.lock()
    defer { stateLock.unlock() }
    let id = peripheral.identifier.uuidString
    failPendingRequestsForDevice(
      deviceId: id,
      errorCode: "BLE_CONNECT_FAILED",
      errorMessage: "Connection failed while operation pending."
    )
    clearDeviceState(deviceId: id)
    connectionStateById[id] = "disconnected"
    emitEvent(type: "connectionStateChanged", payload: ["deviceId": id, "state": "disconnected"])
    emitIssue(
      type: "warning",
      code: "BLE_CONNECT_FAILED",
      message: "Failed to connect peripheral.",
      recoveryHint: "Retry connect.",
      platformDetails: error?.localizedDescription
    )
  }

  func handleDidDisconnect(peripheral: CBPeripheral, error: Error?) {
    stateLock.lock()
    defer { stateLock.unlock() }
    let id = peripheral.identifier.uuidString
    failPendingRequestsForDevice(
      deviceId: id,
      errorCode: "BLE_DEVICE_DISCONNECTED",
      errorMessage: "Device disconnected while operation pending."
    )
    clearDeviceState(deviceId: id)
    connectionStateById[id] = "disconnected"
    emitEvent(type: "connectionStateChanged", payload: ["deviceId": id, "state": "disconnected"])
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
    config.dedupeMode = obj["dedupeMode"] as? String
    config.rssiSmoothingWindow = obj["rssiSmoothingWindow"] as? Int
    if let rw = obj["rankingWeights"] as? [String: Any] {
      config.rankingWeights = RankingWeights(
        rssi: (rw["rssi"] as? NSNumber)?.doubleValue ?? 0.6,
        recency: (rw["recency"] as? NSNumber)?.doubleValue ?? 0.25,
        connectable: (rw["connectable"] as? NSNumber)?.doubleValue ?? 0.1,
        transport: (rw["transport"] as? NSNumber)?.doubleValue ?? 0.05
      )
    }
    if let uuids = obj["serviceUuids"] as? [String] {
      config.serviceUuids = uuids.compactMap { UUID(uuidString: $0) }.map(CBUUID.init)
    }
    return config
  }

  private func clearDeviceState(deviceId: String) {
    connectedPeripherals.removeValue(forKey: deviceId)
    serviceCache.removeValue(forKey: deviceId)
    discoveredPeripherals.removeValue(forKey: deviceId)
    discoverOrder.removeAll { $0 == deviceId }
    pendingDiscoverRequestByDeviceId.removeValue(forKey: deviceId)
    let prefix = "\(deviceId)|"
    pendingReadRequestByKey.keys.filter { $0.hasPrefix(prefix) }.forEach { key in
      pendingReadRequestByKey.removeValue(forKey: key)
    }
    pendingWriteRequestByKey.keys.filter { $0.hasPrefix(prefix) }.forEach { key in
      pendingWriteRequestByKey.removeValue(forKey: key)
    }
    pendingNotifyRequestByKey.keys.filter { $0.hasPrefix(prefix) }.forEach { key in
      pendingNotifyRequestByKey.removeValue(forKey: key)
    }
  }

  private func clearPendingLookup(requestId: String, deviceId: String, addressKey: String?) {
    if pendingDiscoverRequestByDeviceId[deviceId] == requestId {
      pendingDiscoverRequestByDeviceId.removeValue(forKey: deviceId)
    }
    if let addressKey {
      if pendingReadRequestByKey[addressKey] == requestId {
        pendingReadRequestByKey.removeValue(forKey: addressKey)
      }
      if pendingWriteRequestByKey[addressKey] == requestId {
        pendingWriteRequestByKey.removeValue(forKey: addressKey)
      }
      if pendingNotifyRequestByKey[addressKey] == requestId {
        pendingNotifyRequestByKey.removeValue(forKey: addressKey)
      }
    }
  }

  private func completePendingRequest(
    requestId: String,
    success: Bool,
    errorCode: String?,
    errorMessage: String?,
    payload: [String: Any]?
  ) {
    guard let pending = pendingGattByRequestId.removeValue(forKey: requestId) else { return }
    pendingTimeoutByRequestId.removeValue(forKey: requestId)?.cancel()
    clearPendingLookup(requestId: requestId, deviceId: pending.deviceId, addressKey: pending.addressKey)
    emitGattOperationResult(
      requestId: requestId,
      opName: pending.opName,
      deviceId: pending.deviceId,
      success: success,
      errorCode: errorCode,
      errorMessage: errorMessage,
      payload: payload
    )
  }

  private func failPendingRequestsForDevice(deviceId: String, errorCode: String, errorMessage: String) {
    let requestIds = pendingGattByRequestId.values.filter { $0.deviceId == deviceId }.map(\.requestId)
    requestIds.forEach { requestId in
      completePendingRequest(
        requestId: requestId,
        success: false,
        errorCode: errorCode,
        errorMessage: errorMessage,
        payload: nil
      )
    }
  }

  private struct ParsedConfig {
    var allowDuplicates: Bool?
    var coalescingWindowMs: Int64?
    var enableClassicDiscovery: Bool?
    var dedupeMode: String?
    var rssiSmoothingWindow: Int?
    var rankingWeights: RankingWeights?
    var serviceUuids: [CBUUID]?
  }

  private struct CharacteristicAddress {
    let deviceId: String
    let serviceUuid: String
    let characteristicUuid: String
  }

  private func smoothRssi(deviceId: String, rssi: Int) -> Int {
    var history = rssiHistory[deviceId] ?? []
    history.append(rssi)
    if history.count > rssiSmoothingWindow {
      history.removeFirst(history.count - rssiSmoothingWindow)
    }
    rssiHistory[deviceId] = history
    return history.reduce(0, +) / max(history.count, 1)
  }

  private func calculateScore(rssi: Int, isConnectable: Bool, transport: String, seenAt: Int64) -> Double {
    let rssiScore = max(0.0, min(1.0, Double(max(0, min(70, rssi + 100))) / 70.0))
    let ageMs = max(0, nowMs() - seenAt)
    let recencyScore = max(0.0, min(1.0, 1.0 - Double(ageMs) / 15000.0))
    let connectableScore = isConnectable ? 1.0 : 0.0
    let transportScore = transport == "ble" ? 1.0 : 0.7
    let score =
      rankingWeights.rssi * rssiScore
      + rankingWeights.recency * recencyScore
      + rankingWeights.connectable * connectableScore
      + rankingWeights.transport * transportScore
    return (score * 1000).rounded() / 1000
  }

  private func buildFingerprint(id: String, manufacturerData: Data, serviceUuids: [String]) -> String {
    let mf = manufacturerData.prefix(8).map { String($0) }.joined(separator: "-")
    let su = serviceUuids.sorted().prefix(4).joined(separator: "|")
    return "\(id)#\(mf)#\(su)"
  }

  private func parseAddress(_ json: String) -> CharacteristicAddress? {
    guard let data = json.data(using: .utf8),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let deviceId = root["deviceId"] as? String,
          let serviceUuid = root["serviceUuid"] as? String,
          let characteristicUuid = root["characteristicUuid"] as? String
    else { return nil }
    return CharacteristicAddress(deviceId: deviceId, serviceUuid: serviceUuid, characteristicUuid: characteristicUuid)
  }

  private func parseGattOperation(_ json: String) -> GattOperationRequest? {
    guard let data = json.data(using: .utf8),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let requestId = root["requestId"] as? String,
          let opName = root["opName"] as? String,
          let deviceId = root["deviceId"] as? String
    else { return nil }
    let address: CharacteristicAddress?
    if let addr = root["address"] as? [String: Any],
       let addrData = try? JSONSerialization.data(withJSONObject: addr),
       let addrJson = String(data: addrData, encoding: .utf8) {
      address = parseAddress(addrJson)
    } else {
      address = nil
    }
    let value = (root["value"] as? [NSNumber])?.map { UInt8(clamping: $0.intValue) }
    let enable = root["enable"] as? Bool
    let timeoutMs = (root["timeoutMs"] as? NSNumber)?.int64Value ?? 12000
    return GattOperationRequest(
      requestId: requestId,
      opName: opName,
      deviceId: deviceId,
      address: address,
      value: value,
      enable: enable,
      timeoutMs: timeoutMs
    )
  }

  private func characteristicKey(_ address: CharacteristicAddress) -> String {
    return "\(address.deviceId)|\(address.serviceUuid)|\(address.characteristicUuid)"
  }

  private func parseByteArray(_ json: String) -> [UInt8] {
    guard let data = json.data(using: .utf8),
          let arr = try? JSONSerialization.jsonObject(with: data) as? [NSNumber]
    else { return [] }
    return arr.map { UInt8(clamping: $0.intValue) }
  }

  private func findCharacteristic(peripheral: CBPeripheral, address: CharacteristicAddress) -> CBCharacteristic? {
    guard let services = peripheral.services else { return nil }
    for service in services where service.uuid.uuidString.caseInsensitiveCompare(address.serviceUuid) == .orderedSame {
      guard let characteristics = service.characteristics else { continue }
      for characteristic in characteristics
      where characteristic.uuid.uuidString.caseInsensitiveCompare(address.characteristicUuid) == .orderedSame {
        return characteristic
      }
    }
    return nil
  }

  private func parseLong(_ json: String, key: String, fallback: Int64) -> Int64 {
    guard let data = json.data(using: .utf8),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return fallback }
    if let number = root[key] as? NSNumber {
      return number.int64Value
    }
    return fallback
  }

  private func stringifyArray(_ value: [Int]) -> String {
    let arr = value.map { NSNumber(value: $0) }
    guard let data = try? JSONSerialization.data(withJSONObject: arr),
          let str = String(data: data, encoding: .utf8)
    else { return "[]" }
    return str
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

  private func emitGattOperationResult(
    requestId: String,
    opName: String,
    deviceId: String,
    success: Bool,
    errorCode: String?,
    errorMessage: String?,
    payload: [String: Any]?
  ) {
    var body: [String: Any] = [
      "requestId": requestId,
      "opName": opName,
      "deviceId": deviceId,
      "success": success,
    ]
    if let payload {
      payload.forEach { body[$0.key] = $0.value }
    }
    if !success {
      if let errorCode { body["errorCode"] = errorCode }
      if let errorMessage { body["errorMessage"] = errorMessage }
    }
    emitEvent(type: "gattOperationResult", payload: body)
  }

  func handlePeripheralDidDiscoverServices(peripheral: CBPeripheral, error: Error?) {
    stateLock.lock()
    defer { stateLock.unlock() }
    let deviceId = peripheral.identifier.uuidString
    let services = peripheral.services ?? []
    for service in services {
      peripheral.discoverCharacteristics(nil, for: service)
    }
    let jsonServices: [[String: Any]] = services.map { service in
      let characteristics = service.characteristics?.map { $0.uuid.uuidString } ?? []
      return ["uuid": service.uuid.uuidString, "characteristicUuids": characteristics]
    }
    let payload: [String: Any] = ["deviceId": deviceId, "services": jsonServices]
    emitEvent(type: "servicesDiscovered", payload: payload)
    if let data = try? JSONSerialization.data(withJSONObject: jsonServices),
       let json = String(data: data, encoding: .utf8) {
      serviceCache[deviceId] = json
    }
    if let requestId = pendingDiscoverRequestByDeviceId[deviceId] {
      completePendingRequest(
        requestId: requestId,
        success: true,
        errorCode: nil,
        errorMessage: nil,
        payload: ["services": jsonServices]
      )
    }
  }

  func handlePeripheralDidUpdateValue(
    peripheral: CBPeripheral,
    characteristic: CBCharacteristic,
    error: Error?
  ) {
    stateLock.lock()
    defer { stateLock.unlock() }
    let deviceId = peripheral.identifier.uuidString
    let serviceUuid = characteristic.service?.uuid.uuidString ?? ""
    let key = "\(deviceId)|\(serviceUuid)|\(characteristic.uuid.uuidString)"
    let value = (characteristic.value ?? Data()).map { Int($0) }
    if let requestId = pendingReadRequestByKey[key] {
      completePendingRequest(
        requestId: requestId,
        success: error == nil,
        errorCode: error == nil ? nil : "BLE_READ_CHARACTERISTIC_FAILED",
        errorMessage: error?.localizedDescription,
        payload: error == nil ? ["value": value] : nil
      )
    }
    emitEvent(
      type: "characteristicValueChanged",
      payload: [
        "deviceId": deviceId,
        "serviceUuid": serviceUuid,
        "characteristicUuid": characteristic.uuid.uuidString,
        "value": value,
      ]
    )
  }

  func handlePeripheralDidWriteValue(
    peripheral: CBPeripheral,
    characteristic: CBCharacteristic,
    error: Error?
  ) {
    stateLock.lock()
    defer { stateLock.unlock() }
    let serviceUuid = characteristic.service?.uuid.uuidString ?? ""
    let key = "\(peripheral.identifier.uuidString)|\(serviceUuid)|\(characteristic.uuid.uuidString)"
    if let requestId = pendingWriteRequestByKey[key] {
      completePendingRequest(
        requestId: requestId,
        success: error == nil,
        errorCode: error == nil ? nil : "BLE_WRITE_CHARACTERISTIC_FAILED",
        errorMessage: error?.localizedDescription,
        payload: nil
      )
    }
  }

  func handlePeripheralDidUpdateNotificationState(
    peripheral: CBPeripheral,
    characteristic: CBCharacteristic,
    error: Error?
  ) {
    stateLock.lock()
    defer { stateLock.unlock() }
    let serviceUuid = characteristic.service?.uuid.uuidString ?? ""
    let key = "\(peripheral.identifier.uuidString)|\(serviceUuid)|\(characteristic.uuid.uuidString)"
    if let requestId = pendingNotifyRequestByKey[key] {
      completePendingRequest(
        requestId: requestId,
        success: error == nil,
        errorCode: error == nil ? nil : "BLE_SET_NOTIFICATION_FAILED",
        errorMessage: error?.localizedDescription,
        payload: nil
      )
    }
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

  func dispose() {
    stateLock.lock()
    cleanupResourcesLocked()
    stateLock.unlock()
  }

  private func cleanupResourcesLocked() {
    if isDisposed { return }
    isDisposed = true
    if isScanning {
      centralManager.stopScan()
      isScanning = false
    }
    pendingGattByRequestId.keys.forEach { requestId in
      completePendingRequest(
        requestId: requestId,
        success: false,
        errorCode: "BLE_MODULE_DISPOSED",
        errorMessage: "Module disposed while operation pending.",
        payload: nil
      )
    }
    connectedPeripherals.values.forEach { peripheral in
      centralManager.cancelPeripheralConnection(peripheral)
    }
    connectedPeripherals.removeAll()
    discoveredPeripherals.removeAll()
    serviceCache.removeAll()
    pendingTimeoutByRequestId.values.forEach { $0.cancel() }
    pendingTimeoutByRequestId.removeAll()
    pendingDiscoverRequestByDeviceId.removeAll()
    pendingReadRequestByKey.removeAll()
    pendingWriteRequestByKey.removeAll()
    pendingNotifyRequestByKey.removeAll()
    eventListener = nil
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
