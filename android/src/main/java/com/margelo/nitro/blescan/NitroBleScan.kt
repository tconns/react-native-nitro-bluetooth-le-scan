package com.margelo.nitro.blescan

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import kotlin.math.roundToInt
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

@DoNotStrip
class NitroBleScan : HybridNitroBleScanSpec() {
  private val context = NitroModules.applicationContext
    ?: throw IllegalStateException("NitroModules.applicationContext is null")
  private val bluetoothManager =
    context.getSystemService(android.content.Context.BLUETOOTH_SERVICE) as BluetoothManager
  private val stateLock = Any()
  private var scanner: BluetoothLeScanner? = null
  private var scanCallback: ScanCallback? = null
  private var listener: ((String) -> Unit)? = null
  private var classicReceiverRegistered = false
  private var classicDiscoveryEnabled = true
  private var coalescingWindowMs = 150L
  private var dedupeMode = "deviceId"
  private var rssiSmoothingWindow = 5
  private var rankingWeights = RankingWeights()
  private val lastSeenById = HashMap<String, Long>()
  private val rssiHistoryById = HashMap<String, ArrayDeque<Int>>()
  private val gattByDeviceId = ConcurrentHashMap<String, BluetoothGatt>()
  private val connectionStateByDeviceId = ConcurrentHashMap<String, String>()
  private val serviceCacheByDeviceId = ConcurrentHashMap<String, String>()
  private val connectTokenByDeviceId = ConcurrentHashMap<String, Long>()
  private val pendingGattByRequestId = ConcurrentHashMap<String, PendingGattRequest>()
  private val pendingGattTimeoutByRequestId = ConcurrentHashMap<String, ScheduledFuture<*>>()
  private val pendingDiscoverRequestByDeviceId = ConcurrentHashMap<String, String>()
  private val pendingReadRequestByKey = ConcurrentHashMap<String, String>()
  private val pendingWriteRequestByKey = ConcurrentHashMap<String, String>()
  private val pendingNotifyRequestByKey = ConcurrentHashMap<String, String>()
  private val operationScheduler = Executors.newSingleThreadScheduledExecutor()
  private val isShuttingDown = AtomicBoolean(false)
  private var deviceEventCounter = 0
  private val maxTrackedDevices = 512
  private val cacheTtlMs = 120_000L
  private val classicReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: android.content.Context?, intent: Intent?) {
      try {
        if (intent == null) return
        when (intent.action) {
          BluetoothDevice.ACTION_FOUND -> {
            val device = intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE)
            val rssi = intent.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE)
            if (device != null) {
              onClassicDeviceFound(device, rssi.toInt())
            }
          }
          BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> {
            synchronized(stateLock) {
              if (snapshot.isScanning && classicDiscoveryEnabled) {
                val adapter = bluetoothManager.adapter
                if (adapter != null && adapter.isEnabled) {
                  try {
                    adapter.startDiscovery()
                  } catch (_: Throwable) {
                    emitWarning(
                      "BLE_CLASSIC_RESTART_FAILED",
                      "Classic discovery stopped unexpectedly.",
                      "Retry scan or toggle Bluetooth."
                    )
                  }
                }
              }
            }
          }
        }
      } catch (error: Throwable) {
        synchronized(stateLock) {
          snapshot.eventsDropped += 1
          emitWarning(
            "BLE_CLASSIC_CALLBACK_ERROR",
            "Classic callback failed: ${error.message ?: error::class.java.simpleName}",
            "Continue scanning with BLE."
          )
        }
      }
    }
  }

  private val snapshot = SnapshotState(
    isScanning = false,
    adapterState = adapterStateString(),
    lastStartTs = 0L,
    lastStopTs = 0L,
    seenDeviceCount = 0,
    eventsEmitted = 0,
    eventsDropped = 0,
    coalescedCount = 0,
    lastErrorCode = null
  )

  private data class SnapshotState(
    var isScanning: Boolean,
    var adapterState: String,
    var lastStartTs: Long,
    var lastStopTs: Long,
    var seenDeviceCount: Int,
    var eventsEmitted: Int,
    var eventsDropped: Int,
    var coalescedCount: Int,
    var lastErrorCode: String?
  )

  private data class RankingWeights(
    val rssi: Double = 0.6,
    val recency: Double = 0.25,
    val connectable: Double = 0.1,
    val transport: Double = 0.05
  )

  private data class PendingGattRequest(
    val requestId: String,
    val opName: String,
    val deviceId: String,
    val addressKey: String?
  )

  override fun getAdapterState(): String {
    synchronized(stateLock) {
      snapshot.adapterState = adapterStateString()
      return snapshot.adapterState
    }
  }

  override fun ensurePermissions(): Boolean = hasScanPermission()

  override fun setBluetoothEnabled(enable: Boolean): Boolean {
    val adapter = bluetoothManager.adapter ?: return false
    if (!hasScanPermission()) {
      emitWarning(
        "BLE_PERMISSION_DENIED",
        "Missing Bluetooth permission for adapter state change.",
        "Grant permission then retry."
      )
      return false
    }
    return try {
      if (enable) {
        if (adapter.isEnabled) true else adapter.enable()
      } else {
        if (!adapter.isEnabled) true else adapter.disable()
      }
    } catch (error: Throwable) {
      emitWarning(
        "BLE_ADAPTER_TOGGLE_FAILED",
        "Failed to toggle Bluetooth adapter.",
        "Use system Bluetooth settings.",
      )
      false
    }
  }

  override fun startScan(configJson: String): Boolean {
    synchronized(stateLock) {
      if (snapshot.isScanning) {
        emitWarning("BLE_ALREADY_SCANNING", "Scan already running", "Call stopScan() before restarting scan.")
        return true
      }
      if (!hasScanPermission()) {
        emitError("BLE_PERMISSION_DENIED", "Required BLE permissions are missing.", "Request runtime permissions before calling startScan().")
        return false
      }
      if (adapterStateString() != "poweredOn") {
        emitError("BLE_ADAPTER_OFF", "Bluetooth adapter is not powered on.", "Enable Bluetooth, then retry.")
        return false
      }
      val adapter = bluetoothManager.adapter ?: run {
        emitError("BLE_UNSUPPORTED", "Bluetooth adapter is unavailable.", "Run this feature on a BLE-capable device.")
        return false
      }
      scanner = adapter.bluetoothLeScanner ?: run {
        emitError("BLE_SCANNER_UNAVAILABLE", "Bluetooth LE scanner is unavailable.", "Retry after enabling Bluetooth.")
        return false
      }
      val settings = buildScanSettings(configJson)
      val filters = buildScanFilters(configJson)
      coalescingWindowMs = parseConfigLong(configJson, "coalescingWindowMs", 150L).coerceAtLeast(0L)
      classicDiscoveryEnabled = parseConfigBoolean(configJson, "enableClassicDiscovery", true)
      dedupeMode = parseConfigString(configJson, "dedupeMode", "deviceId")
      rssiSmoothingWindow = parseConfigInt(configJson, "rssiSmoothingWindow", 5).coerceIn(1, 20)
      rankingWeights = parseRankingWeights(configJson)
      lastSeenById.clear()
      rssiHistoryById.clear()
      snapshot.seenDeviceCount = 0
      scanCallback = createScanCallback()
      var startedAnyScan = false
      try {
        scanner?.startScan(filters, settings, scanCallback)
        startedAnyScan = true
      } catch (error: Throwable) {
        emitError("BLE_SCAN_FAILED", "Failed to start BLE scan.", "Check permission, adapter state, and retry.", error.message)
      }
      if (classicDiscoveryEnabled) {
        startedAnyScan = startClassicDiscovery(adapter) || startedAnyScan
      }
      if (startedAnyScan) {
        snapshot.isScanning = true
        snapshot.lastStartTs = nowMs()
        snapshot.adapterState = adapterStateString()
        emitSimpleEvent("scanStarted")
      } else {
        emitError("BLE_SCAN_FAILED", "No scan transport could be started.", "Check Bluetooth state and app permissions.")
      }
      return startedAnyScan
    }
  }

  override fun stopScan(): Boolean {
    synchronized(stateLock) {
      if (!snapshot.isScanning) {
        emitWarning("BLE_NOT_SCANNING", "stopScan() called while scanner is idle.", "This call is safe to ignore.")
        return true
      }
      try {
        scanCallback?.let { cb -> scanner?.stopScan(cb) }
      } catch (_: Throwable) {
        // best effort stop
      }
      stopClassicDiscovery()
      scanCallback = null
      scanner = null
      snapshot.isScanning = false
      snapshot.lastStopTs = nowMs()
      snapshot.adapterState = adapterStateString()
      emitSimpleEvent("scanStopped", "manualStop")
      return true
    }
  }

  override fun connect(deviceId: String, optionsJson: String): Boolean {
    if (!hasScanPermission()) {
      emitError("BLE_PERMISSION_DENIED", "Missing Bluetooth permission for connect.", "Grant permission then retry.")
      return false
    }
    val adapter = bluetoothManager.adapter ?: return false
    val timeoutMs = parseConfigLong(optionsJson, "timeoutMs", 10000L).coerceIn(1000L, 30000L)
    return try {
      val currentState = connectionStateByDeviceId[deviceId]
      if (currentState == "connecting" || currentState == "connected") {
        emitWarning("BLE_CONNECT_IN_PROGRESS", "Connect already in progress for $deviceId.", "Wait for connection event.")
        return true
      }
      val device = adapter.getRemoteDevice(deviceId)
      synchronized(stateLock) {
        connectionStateByDeviceId[deviceId] = "connecting"
        emitConnectionState(deviceId, "connecting")
      }
      val gatt =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        } else {
          device.connectGatt(context, false, gattCallback)
        }
      if (gatt == null) {
        emitError("BLE_CONNECT_FAILED", "connectGatt returned null.", "Retry connect.")
        return false
      }
      gattByDeviceId[deviceId] = gatt
      val token = nowMs()
      connectTokenByDeviceId[deviceId] = token
      try {
        operationScheduler.schedule({
          synchronized(stateLock) {
            val stillSameAttempt = connectTokenByDeviceId[deviceId] == token
            val stillConnecting = connectionStateByDeviceId[deviceId] == "connecting"
            if (!stillSameAttempt || !stillConnecting) return@synchronized
            closeGattForDevice(deviceId)
            clearDeviceState(deviceId)
            connectionStateByDeviceId[deviceId] = "disconnected"
            emitConnectionState(deviceId, "disconnected")
            emitError("BLE_CONNECT_TIMEOUT", "Connect timed out for $deviceId.", "Retry or move closer to peripheral.")
          }
        }, timeoutMs, TimeUnit.MILLISECONDS)
      } catch (_: RejectedExecutionException) {
        closeGattForDevice(deviceId)
        clearDeviceState(deviceId)
        return false
      }
      true
    } catch (error: Throwable) {
      closeGattForDevice(deviceId)
      clearDeviceState(deviceId)
      emitError("BLE_CONNECT_FAILED", "Failed to connect $deviceId.", "Retry connection.", error.message)
      false
    }
  }

  override fun disconnect(deviceId: String): Boolean {
    synchronized(stateLock) {
      val gatt = gattByDeviceId[deviceId]
      return try {
        connectionStateByDeviceId[deviceId] = "disconnecting"
        emitConnectionState(deviceId, "disconnecting")
        if (gatt != null) {
          try {
            gatt.disconnect()
          } catch (_: Throwable) {
            // no-op
          }
        }
        closeGattForDevice(deviceId)
        clearDeviceState(deviceId)
        connectionStateByDeviceId[deviceId] = "disconnected"
        emitConnectionState(deviceId, "disconnected")
        true
      } catch (_: Throwable) {
        false
      }
    }
  }

  override fun submitGattOperation(operationJson: String): Boolean {
    val op = parseGattOperation(operationJson) ?: return false
    val gatt = gattByDeviceId[op.deviceId] ?: return false
    val timeoutMs = op.timeoutMs.coerceIn(1000L, 30000L)
    synchronized(stateLock) {
      if (pendingGattByRequestId.containsKey(op.requestId)) return false
      val started =
        when (op.opName) {
          "discoverServices" -> {
            pendingDiscoverRequestByDeviceId[op.deviceId] = op.requestId
            gatt.discoverServices()
          }
          "readCharacteristic" -> {
            val address = op.address ?: return false
            val characteristic = findCharacteristic(gatt, address) ?: return false
            val key = characteristicKey(address)
            pendingReadRequestByKey[key] = op.requestId
            gatt.readCharacteristic(characteristic)
          }
          "writeCharacteristic" -> {
            val address = op.address ?: return false
            val characteristic = findCharacteristic(gatt, address) ?: return false
            val value = op.value ?: emptyList()
            val key = characteristicKey(address)
            pendingWriteRequestByKey[key] = op.requestId
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
              gatt.writeCharacteristic(
                characteristic,
                intListToByteArray(value),
                BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
              ) == BluetoothStatusCodes.SUCCESS
            } else {
              characteristic.value = intListToByteArray(value)
              gatt.writeCharacteristic(characteristic)
            }
          }
          "setCharacteristicNotification" -> {
            val address = op.address ?: return false
            val characteristic = findCharacteristic(gatt, address) ?: return false
            val key = characteristicKey(address)
            if (!gatt.setCharacteristicNotification(characteristic, op.enable == true)) {
              false
            } else {
              val ccc = characteristic.getDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"))
              if (ccc == null) {
                emitGattOperationResult(op.requestId, op.opName, op.deviceId, true, null, null)
                return true
              }
              ccc.value =
                if (op.enable == true) BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                else BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
              pendingNotifyRequestByKey[key] = op.requestId
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeDescriptor(ccc, ccc.value) == BluetoothStatusCodes.SUCCESS
              } else {
                gatt.writeDescriptor(ccc)
              }
            }
          }
          else -> false
        }
      if (!started) {
        clearPendingRequestLookup(op.requestId, op.deviceId, op.address?.let { characteristicKey(it) })
        return false
      }
      pendingGattByRequestId[op.requestId] =
        PendingGattRequest(
          requestId = op.requestId,
          opName = op.opName,
          deviceId = op.deviceId,
          addressKey = op.address?.let { characteristicKey(it) }
        )
      try {
        pendingGattTimeoutByRequestId[op.requestId] = operationScheduler.schedule({
          synchronized(stateLock) {
            completePendingRequest(
              op.requestId,
              success = false,
              errorCode = "BLE_GATT_OPERATION_TIMEOUT",
              errorMessage = "${op.opName} timed out for ${op.deviceId}",
              payload = null
            )
          }
        }, timeoutMs, TimeUnit.MILLISECONDS)
      } catch (_: RejectedExecutionException) {
        completePendingRequest(
          op.requestId,
          success = false,
          errorCode = "BLE_GATT_SCHEDULER_REJECTED",
          errorMessage = "Operation scheduler rejected ${op.opName}",
          payload = null
        )
        return false
      }
      return true
    }
  }

  override fun getSnapshot(): String {
    synchronized(stateLock) {
      snapshot.adapterState = adapterStateString()
      return JSONObject().apply {
        put("isScanning", snapshot.isScanning)
        put("adapterState", snapshot.adapterState)
        if (snapshot.lastStartTs > 0L) put("lastStartTs", snapshot.lastStartTs)
        if (snapshot.lastStopTs > 0L) put("lastStopTs", snapshot.lastStopTs)
        put("seenDeviceCount", snapshot.seenDeviceCount)
        put("eventsEmitted", snapshot.eventsEmitted)
        put("eventsDropped", snapshot.eventsDropped)
        put("coalescedCount", snapshot.coalescedCount)
        if (snapshot.lastErrorCode != null) put("lastErrorCode", snapshot.lastErrorCode)
      }.toString()
    }
  }

  override fun setEventListener(listener: (String) -> Unit) {
    synchronized(stateLock) {
      this.listener = listener
    }
  }

  private val gattCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      synchronized(stateLock) {
        val deviceId = gatt.device?.address ?: return
        if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
          connectTokenByDeviceId.remove(deviceId)
          connectionStateByDeviceId[deviceId] = "connected"
          emitConnectionState(deviceId, "connected")
          return
        }
        connectTokenByDeviceId.remove(deviceId)
        connectionStateByDeviceId[deviceId] = "disconnected"
        emitConnectionState(deviceId, "disconnected")
        failPendingRequestsForDevice(deviceId, "BLE_DEVICE_DISCONNECTED", "Device disconnected during pending GATT operation.")
        closeGattForDevice(deviceId)
        clearDeviceState(deviceId)
      }
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      synchronized(stateLock) {
        val deviceId = gatt.device?.address ?: return
        if (status == BluetoothGatt.GATT_SUCCESS) {
          val services = JSONArray()
          gatt.services?.forEach { service ->
            val chars = JSONArray()
            service.characteristics?.forEach { chars.put(it.uuid.toString()) }
            services.put(
              JSONObject().apply {
                put("uuid", service.uuid.toString())
                put("characteristicUuids", chars)
              }
            )
          }
          val payload = services.toString()
          serviceCacheByDeviceId[deviceId] = payload
          emitEvent(
            "servicesDiscovered",
            JSONObject().apply {
              put("deviceId", deviceId)
              put("services", services)
            }
          )
          val requestId = pendingDiscoverRequestByDeviceId[deviceId]
          if (requestId != null) {
            completePendingRequest(requestId, true, null, null, services)
          }
        } else {
          val requestId = pendingDiscoverRequestByDeviceId[deviceId]
          if (requestId != null) {
            completePendingRequest(
              requestId,
              false,
              "BLE_DISCOVER_SERVICES_FAILED",
              "discoverServices failed with status=$status",
              null
            )
          }
        }
      }
    }

    override fun onCharacteristicRead(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
      status: Int
    ) {
      synchronized(stateLock) {
        val deviceId = gatt.device?.address ?: return
        val key = "$deviceId|${characteristic.service.uuid}|${characteristic.uuid}"
        if (status == BluetoothGatt.GATT_SUCCESS) {
          val requestId = pendingReadRequestByKey[key]
          if (requestId != null) {
            completePendingRequest(
              requestId,
              true,
              null,
              null,
              JSONArray(value.map { byte: Byte -> byte.toInt() and 0xFF })
            )
          }
        } else {
          val requestId = pendingReadRequestByKey[key]
          if (requestId != null) {
            completePendingRequest(
              requestId,
              false,
              "BLE_READ_CHARACTERISTIC_FAILED",
              "readCharacteristic failed with status=$status",
              null
            )
          }
        }
      }
    }

    override fun onCharacteristicRead(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int
    ) {
      synchronized(stateLock) {
        val deviceId = gatt.device?.address ?: return
        val key = "$deviceId|${characteristic.service.uuid}|${characteristic.uuid}"
        if (status == BluetoothGatt.GATT_SUCCESS) {
          val requestId = pendingReadRequestByKey[key]
          if (requestId != null) {
            completePendingRequest(
              requestId,
              true,
              null,
              null,
              JSONArray((characteristic.value ?: byteArrayOf()).map { byte: Byte -> byte.toInt() and 0xFF })
            )
          }
        } else {
          val requestId = pendingReadRequestByKey[key]
          if (requestId != null) {
            completePendingRequest(
              requestId,
              false,
              "BLE_READ_CHARACTERISTIC_FAILED",
              "readCharacteristic failed with status=$status",
              null
            )
          }
        }
      }
    }

    override fun onCharacteristicWrite(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int
    ) {
      synchronized(stateLock) {
        val deviceId = gatt.device?.address ?: return
        val key = "$deviceId|${characteristic.service.uuid}|${characteristic.uuid}"
        val requestId = pendingWriteRequestByKey[key]
        if (requestId != null) {
          completePendingRequest(
            requestId,
            status == BluetoothGatt.GATT_SUCCESS,
            if (status == BluetoothGatt.GATT_SUCCESS) null else "BLE_WRITE_CHARACTERISTIC_FAILED",
            if (status == BluetoothGatt.GATT_SUCCESS) null else "writeCharacteristic failed with status=$status",
            null
          )
        }
      }
    }

    override fun onDescriptorWrite(
      gatt: BluetoothGatt,
      descriptor: BluetoothGattDescriptor,
      status: Int
    ) {
      synchronized(stateLock) {
        val deviceId = gatt.device?.address ?: return
        val key = "$deviceId|${descriptor.characteristic.service.uuid}|${descriptor.characteristic.uuid}"
        val requestId = pendingNotifyRequestByKey[key]
        if (requestId != null) {
          completePendingRequest(
            requestId,
            status == BluetoothGatt.GATT_SUCCESS,
            if (status == BluetoothGatt.GATT_SUCCESS) null else "BLE_SET_NOTIFICATION_FAILED",
            if (status == BluetoothGatt.GATT_SUCCESS) null else "setCharacteristicNotification failed with status=$status",
            null
          )
        }
      }
    }

    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray
    ) {
      synchronized(stateLock) {
        val deviceId = gatt.device?.address ?: return
        emitEvent(
          "characteristicValueChanged",
          JSONObject().apply {
            put("deviceId", deviceId)
            put("serviceUuid", characteristic.service.uuid.toString())
            put("characteristicUuid", characteristic.uuid.toString())
            put("value", JSONArray(value.map { byte: Byte -> byte.toInt() and 0xFF }))
          }
        )
      }
    }

    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic
    ) {
      synchronized(stateLock) {
        val value = characteristic.value ?: byteArrayOf()
        onCharacteristicChanged(gatt, characteristic, value)
      }
    }
  }

  private fun createScanCallback(): ScanCallback {
    return object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult?) {
        try {
          if (result != null) onDeviceFound(result)
        } catch (error: Throwable) {
          synchronized(stateLock) {
            snapshot.eventsDropped += 1
            emitWarning(
              "BLE_SCAN_CALLBACK_ERROR",
              "Scan callback failed: ${error.message ?: error::class.java.simpleName}",
              "Continue scanning or restart scan."
            )
          }
        }
      }

      override fun onBatchScanResults(results: MutableList<ScanResult>?) {
        try {
          results?.forEach(::onDeviceFound)
        } catch (error: Throwable) {
          synchronized(stateLock) {
            snapshot.eventsDropped += 1
            emitWarning(
              "BLE_SCAN_BATCH_CALLBACK_ERROR",
              "Batch callback failed: ${error.message ?: error::class.java.simpleName}",
              "Continue scanning or restart scan."
            )
          }
        }
      }

      override fun onScanFailed(errorCode: Int) {
        synchronized(stateLock) {
          snapshot.eventsDropped += 1
          snapshot.lastErrorCode = "BLE_SCAN_FAILED_$errorCode"
          emitError(
            "BLE_SCAN_FAILED",
            "BLE scan failed with Android error code $errorCode.",
            "Stop scanning, verify permissions and adapter state, then retry.",
            "androidErrorCode=$errorCode"
          )
          if (snapshot.isScanning) {
            snapshot.isScanning = false
            snapshot.lastStopTs = nowMs()
            emitSimpleEvent("scanStopped", "scanFailed")
          }
        }
      }
    }
  }

  private fun onDeviceFound(result: ScanResult) {
    synchronized(stateLock) {
      val device = result.device ?: return
      val deviceId = safeDeviceAddress(device) ?: return
      val now = nowMs()
      val rawManufacturerData = result.scanRecord?.manufacturerSpecificData
      val manufacturerBytes = extractManufacturerData(rawManufacturerData)
      val serviceUuids = result.scanRecord?.serviceUuids?.map { it.uuid.toString() } ?: emptyList()
      val serviceData = extractServiceData(result)
      val fingerprint = buildFingerprint(deviceId, manufacturerBytes, serviceUuids)
      val dedupeKey = if (dedupeMode == "fingerprint") fingerprint else deviceId
      maybePruneScanCaches(now)
      val lastSeen = lastSeenById[dedupeKey]
      if (lastSeen != null && now - lastSeen < coalescingWindowMs) {
        snapshot.coalescedCount += 1
        return
      }
      lastSeenById[dedupeKey] = now
      snapshot.seenDeviceCount = lastSeenById.size
      val smoothedRssi = smoothRssi(deviceId, result.rssi)
      val score = calculateScore(
        rssi = smoothedRssi,
        isConnectable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) result.isConnectable else false,
        transport = "ble",
        seenAt = now
      )
      val payload = JSONObject().apply {
        put("id", deviceId)
        put("transport", "ble")
        put("name", safeDeviceName(device) ?: result.scanRecord?.deviceName)
        put("rssi", result.rssi)
        put("smoothedRssi", smoothedRssi)
        put("score", score)
        put("fingerprint", fingerprint)
        put("timestampMs", now)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          put("txPower", result.txPower)
          put("isConnectable", result.isConnectable)
        }
        val uuids = JSONArray()
        serviceUuids.forEach { uuids.put(it) }
        put("serviceUuids", uuids)
        val manufacturerJson = JSONArray()
        manufacturerBytes.forEach { manufacturerJson.put(it) }
        put("manufacturerData", manufacturerJson)
        val serviceDataJson = JSONObject()
        serviceData.forEach { (key, value) ->
          val arr = JSONArray()
          value.forEach { arr.put(it) }
          serviceDataJson.put(key, arr)
        }
        put("serviceData", serviceDataJson)
      }
      val event = JSONObject().apply {
        put("type", "deviceFound")
        put("ts", now)
        put("payload", payload)
      }
      emitRawEvent(event)
    }
  }

  private fun onClassicDeviceFound(device: BluetoothDevice, rssi: Int) {
    synchronized(stateLock) {
      val deviceId = safeDeviceAddress(device) ?: return
      val now = nowMs()
      val fingerprint = buildFingerprint(deviceId, emptyList(), emptyList())
      val dedupeKey = if (dedupeMode == "fingerprint") fingerprint else deviceId
      maybePruneScanCaches(now)
      val lastSeen = lastSeenById[dedupeKey]
      if (lastSeen != null && now - lastSeen < coalescingWindowMs) {
        snapshot.coalescedCount += 1
        return
      }
      lastSeenById[dedupeKey] = now
      snapshot.seenDeviceCount = lastSeenById.size
      val smoothedRssi = smoothRssi(deviceId, rssi)
      val score = calculateScore(
        rssi = smoothedRssi,
        isConnectable = true,
        transport = "classic",
        seenAt = now
      )
      val payload = JSONObject().apply {
        put("id", deviceId)
        put("transport", "classic")
        put("name", safeDeviceName(device))
        put("rssi", rssi)
        put("smoothedRssi", smoothedRssi)
        put("score", score)
        put("fingerprint", fingerprint)
        put("timestampMs", now)
      }
      val event = JSONObject().apply {
        put("type", "deviceFound")
        put("ts", now)
        put("payload", payload)
      }
      emitRawEvent(event)
    }
  }

  private fun emitSimpleEvent(type: String, reason: String? = null) {
    val event = JSONObject().apply {
      put("type", type)
      put("ts", nowMs())
      if (reason != null) put("reason", reason)
    }
    emitRawEvent(event)
  }

  private fun emitWarning(code: String, message: String, recoveryHint: String? = null) {
    emitIssue("warning", code, message, recoveryHint, null)
  }

  private fun emitError(code: String, message: String, recoveryHint: String? = null, platformDetails: String? = null) {
    snapshot.lastErrorCode = code
    emitIssue("error", code, message, recoveryHint, platformDetails)
  }

  private fun emitIssue(
    type: String,
    code: String,
    message: String,
    recoveryHint: String?,
    platformDetails: String?
  ) {
    val event = JSONObject().apply {
      put("type", type)
      put("ts", nowMs())
      put("payload", JSONObject().apply {
        put("code", code)
        put("message", message)
        if (recoveryHint != null) put("recoveryHint", recoveryHint)
        if (platformDetails != null) put("platformDetails", platformDetails)
      })
    }
    emitRawEvent(event)
  }

  private fun emitConnectionState(deviceId: String, state: String) {
    emitEvent(
      "connectionStateChanged",
      JSONObject().apply {
        put("deviceId", deviceId)
        put("state", state)
      }
    )
  }

  private fun emitEvent(type: String, payload: JSONObject) {
    emitRawEvent(
      JSONObject().apply {
        put("type", type)
        put("ts", nowMs())
        put("payload", payload)
      }
    )
  }

  private fun emitGattOperationResult(
    requestId: String,
    opName: String,
    deviceId: String,
    success: Boolean,
    errorCode: String?,
    errorMessage: String?,
    payload: Any? = null
  ) {
    val body = JSONObject().apply {
      put("requestId", requestId)
      put("opName", opName)
      put("deviceId", deviceId)
      put("success", success)
      when {
        opName == "discoverServices" && payload is JSONArray -> put("services", payload)
        opName == "readCharacteristic" && payload is JSONArray -> put("value", payload)
      }
      if (!success) {
        if (errorCode != null) put("errorCode", errorCode)
        if (errorMessage != null) put("errorMessage", errorMessage)
      }
    }
    emitEvent("gattOperationResult", body)
  }

  private fun emitRawEvent(event: JSONObject) {
    listener?.let {
      try {
        it(event.toString())
        snapshot.eventsEmitted += 1
      } catch (_: Throwable) {
        snapshot.eventsDropped += 1
      }
    } ?: run {
      snapshot.eventsDropped += 1
    }
  }

  private data class CharacteristicAddress(
    val deviceId: String,
    val serviceUuid: String,
    val characteristicUuid: String
  )

  private data class GattOperationRequest(
    val requestId: String,
    val opName: String,
    val deviceId: String,
    val address: CharacteristicAddress?,
    val value: List<Int>?,
    val enable: Boolean?,
    val timeoutMs: Long
  )

  private fun parseGattOperation(json: String): GattOperationRequest? {
    return try {
      val root = JSONObject(json)
      val opName = root.optString("opName")
      val requestId = root.optString("requestId")
      val deviceId = root.optString("deviceId")
      if (opName.isBlank() || requestId.isBlank() || deviceId.isBlank()) return null
      val addressJson = root.optJSONObject("address")?.toString()
      GattOperationRequest(
        requestId = requestId,
        opName = opName,
        deviceId = deviceId,
        address = addressJson?.let(::parseAddress),
        value = root.optJSONArray("value")?.toString()?.let(::parseByteArray),
        enable = if (root.has("enable")) root.optBoolean("enable") else null,
        timeoutMs = root.optLong("timeoutMs", 12000L)
      )
    } catch (_: Throwable) {
      null
    }
  }

  private fun parseAddress(json: String): CharacteristicAddress? {
    return try {
      val root = JSONObject(json)
      CharacteristicAddress(
        deviceId = root.optString("deviceId"),
        serviceUuid = root.optString("serviceUuid"),
        characteristicUuid = root.optString("characteristicUuid")
      )
    } catch (_: Throwable) {
      null
    }
  }

  private fun parseByteArray(json: String): List<Int> {
    return try {
      val arr = JSONArray(json)
      List(arr.length()) { index -> arr.optInt(index, 0).coerceIn(0, 255) }
    } catch (_: Throwable) {
      emptyList()
    }
  }

  private fun intListToByteArray(value: List<Int>): ByteArray {
    return ByteArray(value.size) { index -> value[index].toByte() }
  }

  private fun findCharacteristic(
    gatt: BluetoothGatt,
    address: CharacteristicAddress
  ): BluetoothGattCharacteristic? {
    val service = gatt.getService(UUID.fromString(address.serviceUuid)) ?: return null
    return service.getCharacteristic(UUID.fromString(address.characteristicUuid))
  }

  private fun characteristicKey(address: CharacteristicAddress): String {
    return "${address.deviceId}|${address.serviceUuid}|${address.characteristicUuid}"
  }

  private fun closeGattForDevice(deviceId: String) {
    val gatt = gattByDeviceId.remove(deviceId) ?: return
    try {
      gatt.disconnect()
    } catch (_: Throwable) {
      // no-op
    }
    try {
      gatt.close()
    } catch (_: Throwable) {
      // no-op
    }
  }

  private fun clearOperationStateForDevice(deviceId: String) {
    val prefix = "$deviceId|"
    pendingReadRequestByKey.keys.filter { it.startsWith(prefix) }.forEach { key ->
      pendingReadRequestByKey.remove(key)
    }
    pendingWriteRequestByKey.keys.filter { it.startsWith(prefix) }.forEach { key ->
      pendingWriteRequestByKey.remove(key)
    }
    pendingNotifyRequestByKey.keys.filter { it.startsWith(prefix) }.forEach { key ->
      pendingNotifyRequestByKey.remove(key)
    }
    pendingDiscoverRequestByDeviceId.remove(deviceId)
  }

  private fun clearDeviceState(deviceId: String) {
    connectTokenByDeviceId.remove(deviceId)
    serviceCacheByDeviceId.remove(deviceId)
    clearOperationStateForDevice(deviceId)
  }

  private fun clearPendingRequestLookup(requestId: String, deviceId: String, addressKey: String?) {
    if (pendingDiscoverRequestByDeviceId[deviceId] == requestId) {
      pendingDiscoverRequestByDeviceId.remove(deviceId)
    }
    if (addressKey != null) {
      if (pendingReadRequestByKey[addressKey] == requestId) pendingReadRequestByKey.remove(addressKey)
      if (pendingWriteRequestByKey[addressKey] == requestId) pendingWriteRequestByKey.remove(addressKey)
      if (pendingNotifyRequestByKey[addressKey] == requestId) pendingNotifyRequestByKey.remove(addressKey)
    }
  }

  private fun completePendingRequest(
    requestId: String,
    success: Boolean,
    errorCode: String?,
    errorMessage: String?,
    payload: Any?
  ) {
    val pending = pendingGattByRequestId.remove(requestId) ?: return
    pendingGattTimeoutByRequestId.remove(requestId)?.cancel(true)
    clearPendingRequestLookup(requestId, pending.deviceId, pending.addressKey)
    emitGattOperationResult(
      requestId = requestId,
      opName = pending.opName,
      deviceId = pending.deviceId,
      success = success,
      errorCode = errorCode,
      errorMessage = errorMessage,
      payload = payload
    )
  }

  private fun failPendingRequestsForDevice(deviceId: String, errorCode: String, errorMessage: String) {
    val pending = pendingGattByRequestId.values.filter { it.deviceId == deviceId }
    pending.forEach { request ->
      completePendingRequest(request.requestId, false, errorCode, errorMessage, null)
    }
  }

  private fun maybePruneScanCaches(now: Long) {
    deviceEventCounter += 1
    if (deviceEventCounter % 128 != 0 && lastSeenById.size <= maxTrackedDevices) return
    val staleKeys =
      lastSeenById.entries
        .filter { entry -> now - entry.value > cacheTtlMs }
        .map { it.key }
    staleKeys.forEach { key -> lastSeenById.remove(key) }
    if (lastSeenById.size > maxTrackedDevices) {
      val oldest =
        lastSeenById.entries
          .sortedBy { it.value }
          .take(lastSeenById.size - maxTrackedDevices)
      oldest.forEach { entry -> lastSeenById.remove(entry.key) }
    }
    if (rssiHistoryById.size > maxTrackedDevices) {
      val overflow = rssiHistoryById.keys.take(rssiHistoryById.size - maxTrackedDevices)
      overflow.forEach { key -> rssiHistoryById.remove(key) }
    }
  }

  private fun shutdownModuleResources() {
    if (!isShuttingDown.compareAndSet(false, true)) return
    pendingGattByRequestId.keys.toList().forEach { requestId ->
      completePendingRequest(
        requestId,
        success = false,
        errorCode = "BLE_MODULE_DISPOSED",
        errorMessage = "Module disposed while operation was pending.",
        payload = null
      )
    }
    try {
      operationScheduler.shutdownNow()
    } catch (_: Throwable) {
      // no-op
    }
    gattByDeviceId.keys.toList().forEach { deviceId ->
      closeGattForDevice(deviceId)
      clearDeviceState(deviceId)
    }
    connectionStateByDeviceId.clear()
    pendingGattTimeoutByRequestId.clear()
    pendingDiscoverRequestByDeviceId.clear()
    pendingReadRequestByKey.clear()
    pendingWriteRequestByKey.clear()
    pendingNotifyRequestByKey.clear()
  }

  private fun buildScanSettings(configJson: String): ScanSettings {
    val mode = parseConfigString(configJson, "mode", "balanced")
    val reportDelay = parseConfigLong(configJson, "reportDelayMs", 0L).coerceAtLeast(0L)
    val androidMode = when (mode) {
      "lowLatency" -> ScanSettings.SCAN_MODE_LOW_LATENCY
      "lowPower" -> ScanSettings.SCAN_MODE_LOW_POWER
      else -> ScanSettings.SCAN_MODE_BALANCED
    }
    return ScanSettings.Builder()
      .setScanMode(androidMode)
      .setReportDelay(reportDelay)
      .build()
  }

  private fun buildScanFilters(configJson: String): List<ScanFilter> {
    val filters = mutableListOf<ScanFilter>()
    try {
      val root = JSONObject(configJson)
      val arr = root.optJSONArray("filters") ?: return emptyList()
      for (i in 0 until arr.length()) {
        val item = arr.optJSONObject(i) ?: continue
        val builder = ScanFilter.Builder()
        item.optString("namePrefix").takeIf { it.isNotBlank() }?.let(builder::setDeviceName)
        filters += builder.build()
      }
    } catch (_: Throwable) {
      return emptyList()
    }
    return filters
  }

  private fun parseConfigString(configJson: String, key: String, fallback: String): String {
    return try {
      JSONObject(configJson).optString(key, fallback)
    } catch (_: Throwable) {
      fallback
    }
  }

  private fun parseConfigLong(configJson: String, key: String, fallback: Long): Long {
    return try {
      JSONObject(configJson).optLong(key, fallback)
    } catch (_: Throwable) {
      fallback
    }
  }

  private fun parseConfigInt(configJson: String, key: String, fallback: Int): Int {
    return try {
      JSONObject(configJson).optInt(key, fallback)
    } catch (_: Throwable) {
      fallback
    }
  }

  private fun parseConfigBoolean(configJson: String, key: String, fallback: Boolean): Boolean {
    return try {
      JSONObject(configJson).optBoolean(key, fallback)
    } catch (_: Throwable) {
      fallback
    }
  }

  private fun parseRankingWeights(configJson: String): RankingWeights {
    return try {
      val root = JSONObject(configJson)
      val weights = root.optJSONObject("rankingWeights") ?: return RankingWeights()
      RankingWeights(
        rssi = weights.optDouble("rssi", 0.6),
        recency = weights.optDouble("recency", 0.25),
        connectable = weights.optDouble("connectable", 0.1),
        transport = weights.optDouble("transport", 0.05)
      )
    } catch (_: Throwable) {
      RankingWeights()
    }
  }

  private fun smoothRssi(deviceId: String, rssi: Int): Int {
    val history = rssiHistoryById.getOrPut(deviceId) { ArrayDeque() }
    history.addLast(rssi)
    while (history.size > rssiSmoothingWindow) {
      history.removeFirst()
    }
    return history.average().toInt()
  }

  private fun calculateScore(
    rssi: Int,
    isConnectable: Boolean,
    transport: String,
    seenAt: Long
  ): Double {
    val rssiScore = ((rssi + 100).coerceIn(0, 70) / 70.0)
    val ageScore = (1.0 - ((nowMs() - seenAt).coerceAtLeast(0L) / 15000.0)).coerceIn(0.0, 1.0)
    val connectableScore = if (isConnectable) 1.0 else 0.0
    val transportScore = if (transport == "ble") 1.0 else 0.7
    val score =
      rankingWeights.rssi * rssiScore +
      rankingWeights.recency * ageScore +
      rankingWeights.connectable * connectableScore +
      rankingWeights.transport * transportScore
    return (score * 1000.0).roundToInt() / 1000.0
  }

  private fun buildFingerprint(
    id: String,
    manufacturerData: List<Int>,
    serviceUuids: List<String>
  ): String {
    val mf = manufacturerData.take(8).joinToString("-")
    val su = serviceUuids.sorted().take(4).joinToString("|")
    return "$id#$mf#$su"
  }

  private fun extractManufacturerData(data: android.util.SparseArray<ByteArray>?): List<Int> {
    if (data == null || data.size() == 0) return emptyList()
    val bytes = mutableListOf<Int>()
    for (index in 0 until data.size()) {
      val chunk = data.valueAt(index) ?: continue
      chunk.forEach { bytes.add(it.toInt() and 0xFF) }
      if (bytes.size >= 24) break
    }
    return bytes.take(24)
  }

  private fun extractServiceData(result: ScanResult): Map<String, List<Int>> {
    val serviceData = mutableMapOf<String, List<Int>>()
    val record = result.scanRecord ?: return serviceData
    val map = record.serviceData ?: return serviceData
    map.entries.forEach { (uuid, data) ->
      if (uuid == null || data == null) return@forEach
      serviceData[uuid.uuid.toString()] = data.take(20).map { it.toInt() and 0xFF }
    }
    return serviceData
  }

  private fun startClassicDiscovery(adapter: BluetoothAdapter): Boolean {
    if (!hasClassicPermission()) {
      emitWarning(
        "BLE_CLASSIC_PERMISSION_DENIED",
        "Missing permission for classic Bluetooth discovery.",
        "Grant Location permission and retry."
      )
      return false
    }
    if (!isLocationServiceEnabled()) {
      emitWarning(
        "BLE_CLASSIC_LOCATION_DISABLED",
        "Location service is disabled, classic discovery may fail.",
        "Enable Location service (GPS) and retry."
      )
    }
    try {
      if (!classicReceiverRegistered) {
        val filter = IntentFilter().apply {
          addAction(BluetoothDevice.ACTION_FOUND)
          addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
        }
        context.registerReceiver(classicReceiver, filter)
        classicReceiverRegistered = true
      }
      if (adapter.isDiscovering) {
        adapter.cancelDiscovery()
      }
      val started = adapter.startDiscovery()
      if (!started) {
        emitWarning(
          "BLE_CLASSIC_START_FAILED",
          "Failed to start classic Bluetooth discovery. adapterOn=${adapter.isEnabled} discovering=${adapter.isDiscovering}",
          "Ensure Bluetooth is enabled and try again."
        )
      }
      return started
    } catch (error: Throwable) {
      emitWarning(
        "BLE_CLASSIC_START_FAILED",
        "Classic Bluetooth discovery is unavailable. ${error.message ?: ""}".trim(),
        "Continue with BLE-only scan."
      )
      return false
    }
  }

  private fun stopClassicDiscovery() {
    val adapter = bluetoothManager.adapter
    try {
      if (adapter?.isDiscovering == true) {
        adapter.cancelDiscovery()
      }
    } catch (_: Throwable) {
      // no-op
    }
    if (classicReceiverRegistered) {
      try {
        context.unregisterReceiver(classicReceiver)
      } catch (_: Throwable) {
        // no-op
      }
      classicReceiverRegistered = false
    }
  }

  private fun safeDeviceAddress(device: BluetoothDevice): String? {
    return try {
      device.address
    } catch (_: SecurityException) {
      snapshot.eventsDropped += 1
      null
    } catch (_: Throwable) {
      null
    }
  }

  private fun safeDeviceName(device: BluetoothDevice): String? {
    return try {
      device.name
    } catch (_: SecurityException) {
      null
    } catch (_: Throwable) {
      null
    }
  }

  private fun hasScanPermission(): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val scan = ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
      val connect = ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
      return scan && connect
    }
    return ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
  }

  private fun hasClassicPermission(): Boolean {
    return ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
  }

  private fun isLocationServiceEnabled(): Boolean {
    return try {
      val manager = context.getSystemService(android.content.Context.LOCATION_SERVICE) as LocationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        manager.isLocationEnabled
      } else {
        manager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
          manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
      }
    } catch (_: Throwable) {
      true
    }
  }

  private fun adapterStateString(): String {
    val adapter: BluetoothAdapter = bluetoothManager.adapter ?: return "unsupported"
    return when (adapter.state) {
      BluetoothAdapter.STATE_OFF -> "poweredOff"
      BluetoothAdapter.STATE_ON -> "poweredOn"
      BluetoothAdapter.STATE_TURNING_ON -> "resetting"
      BluetoothAdapter.STATE_TURNING_OFF -> "resetting"
      else -> "unknown"
    }
  }

  private fun nowMs(): Long = System.currentTimeMillis()

  override fun dispose() {
    synchronized(stateLock) {
      try {
        scanCallback?.let { cb -> scanner?.stopScan(cb) }
      } catch (_: Throwable) {
        // no-op
      }
      stopClassicDiscovery()
      scanCallback = null
      scanner = null
      snapshot.isScanning = false
      listener = null
      shutdownModuleResources()
    }
  }
}
