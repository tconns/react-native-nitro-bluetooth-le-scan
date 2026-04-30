jest.mock('react-native-nitro-modules', () => {
  const instances: any[] = []
  return {
    NitroModules: {
      createHybridObject: () => {
        const instance = {
          getAdapterState: () => 'poweredOn',
          ensurePermissions: () => true,
          setBluetoothEnabled: () => true,
          startScan: () => true,
          stopScan: () => true,
          connect: () => true,
          disconnect: () => true,
          submitGattOperation: () => true,
          getSnapshot: () => '{"isScanning":false,"adapterState":"poweredOn","seenDeviceCount":0,"eventsEmitted":0,"eventsDropped":0,"coalescedCount":0}',
          setEventListener: () => undefined,
          dispose: jest.fn(() => undefined),
        }
        instances.push(instance)
        return instance
      },
    },
    __nitroMock: {
      getInstanceCount: () => instances.length,
      getLastInstance: () => instances[instances.length - 1],
    },
  }
})

describe('react-native-nitro-bluetooth-le-scan', () => {
  it('exports runtime symbols', () => {
    const mod = require('../index')
    expect(typeof mod.startBleScan).toBe('function')
    expect(typeof mod.stopBleScan).toBe('function')
    expect(typeof mod.enableBleAdapter).toBe('function')
    expect(typeof mod.disableBleAdapter).toBe('function')
    expect(typeof mod.setBleAdapterEnabled).toBe('function')
    expect(typeof mod.getBleScanSnapshot).toBe('function')
    expect(typeof mod.subscribeBleScan).toBe('function')
    expect(typeof mod.rankDevices).toBe('function')
    expect(typeof mod.estimateDistance).toBe('function')
    expect(typeof mod.registerManufacturerParser).toBe('function')
    expect(typeof mod.connectBleDevice).toBe('function')
    expect(typeof mod.discoverBleServices).toBe('function')
    expect(typeof mod.disconnectBleDevice).toBe('function')
    expect(typeof mod.disposeBleRuntime).toBe('function')
    expect(typeof mod.safeConnect).toBe('function')
    expect(typeof mod.readWithRetry).toBe('function')
    expect(typeof mod.createNotificationManager).toBe('function')
    expect(typeof mod.useBleScan).toBe('function')
    expect(typeof mod.useBleAdapterState).toBe('function')
    expect(typeof mod.useBlePermissions).toBe('function')
  })

  it('ranks stronger signal device first', () => {
    const mod = require('../index')
    const ranked = mod.rankDevices([
      {id: 'a', rssi: -80, timestampMs: Date.now() - 1000},
      {id: 'b', rssi: -55, timestampMs: Date.now() - 1000},
    ])
    expect(ranked[0].id).toBe('b')
  })

  it('allows parser registration', async () => {
    const mod = require('../index')
    mod.registerManufacturerParser({
      id: 'test-parser',
      canParse: () => true,
      parse: () => ({ok: true}),
    })
    const seen: any[] = []
    const unsub = mod.subscribeBleScan((event: any) => seen.push(event))
    unsub()
    expect(seen).toEqual([])
  })

  it('guards duplicate notification subscriptions', async () => {
    const mod = require('../index')
    const notifications: ((value: number[]) => void)[] = []
    const manager = mod.createNotificationManager()
    const adapter = {
      subscribeNotification: async (_address: any, onValue: (value: number[]) => void) => {
        notifications.push(onValue)
        return () => undefined
      },
    }
    const address = {
      deviceId: 'd1',
      serviceUuid: 's1',
      characteristicUuid: 'c1',
    }
    const first = await manager.subscribe(adapter, address, () => undefined)
    const second = await manager.subscribe(adapter, address, () => undefined)
    expect(first).toBe(true)
    expect(second).toBe(false)
  })

  it('queues operations sequentially per device', async () => {
    const mod = require('../index')
    const queue = mod.createGattOperationQueue()
    const order: string[] = []
    const p1 = queue.enqueue('d1', async () => {
      order.push('a:start')
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('a:end')
      return 'a'
    })
    const p2 = queue.enqueue('d1', async () => {
      order.push('b:start')
      order.push('b:end')
      return 'b'
    })
    await Promise.all([p1, p2])
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('injects failures for QA fault simulation', async () => {
    const mod = require('../index')
    const adapter = {
      connect: async () => undefined,
      disconnect: async () => undefined,
      discoverServices: async () => [],
      readCharacteristic: async () => [1],
      writeCharacteristic: async () => undefined,
      subscribeNotification: async () => () => undefined,
    }
    const injected = mod.createFaultInjectionAdapter(adapter, {
      connect: {failTimes: 1, failWith: 'forced connect fail'},
    })

    await expect(injected.connect('d1')).rejects.toThrow('forced connect fail')
    await expect(injected.connect('d1')).resolves.toBeUndefined()
  })

  it('builds runtime health report from events and metrics', () => {
    const mod = require('../index')
    const monitor = mod.createRuntimeHealthMonitor()
    const now = Date.now()
    monitor.onScanEvent({type: 'scanStarted', ts: now})
    monitor.onScanEvent({
      type: 'connectionStateChanged',
      ts: now + 10,
      payload: {deviceId: 'd1', state: 'connecting'},
    })
    monitor.onScanEvent({
      type: 'connectionStateChanged',
      ts: now + 110,
      payload: {deviceId: 'd1', state: 'connected'},
    })
    monitor.onScanEvent({
      type: 'warning',
      ts: now + 120,
      payload: {code: 'BLE_CONNECT_TIMEOUT', message: 'timeout'},
    })
    monitor.onGattMetric({
      opName: 'discoverServices',
      deviceId: 'd1',
      startedAtMs: now + 130,
      elapsedMs: 50,
      success: true,
    })
    const report = monitor.getReport()
    const trace = monitor.getTrace(10)
    expect(report.scan.sessionCount).toBe(1)
    expect(report.connection.attempts).toBe(1)
    expect(report.connection.successes).toBe(1)
    expect(report.connection.avgConnectLatencyMs).toBe(100)
    expect(report.connection.timeouts).toBe(1)
    expect(report.connection.gattOpSuccessRate).toBe(1)
    expect(trace.length).toBeGreaterThan(0)
  })

  it('supports idempotent notification manager clear', async () => {
    const mod = require('../index')
    const manager = mod.createNotificationManager()
    let unsubCalls = 0
    const adapter = {
      subscribeNotification: async () => () => {
        unsubCalls += 1
      },
    }
    const address = {deviceId: 'd2', serviceUuid: 's2', characteristicUuid: 'c2'}
    await manager.subscribe(adapter, address, () => undefined)
    manager.clear()
    manager.clear()
    expect(unsubCalls).toBe(1)
  })

  it('times out operations with explicit timeout helper', async () => {
    const mod = require('../index')
    await expect(
      mod.withTimeout(
        new Promise((resolve) => setTimeout(resolve, 30)),
        5,
        'slow-op'
      )
    ).rejects.toThrow('slow-op timed out after 5ms')
  })

  it('retries operation and succeeds on a later attempt', async () => {
    const mod = require('../index')
    let attempts = 0
    const result = await mod.withRetry(async () => {
      attempts += 1
      if (attempts < 3) {
        throw new Error(`attempt-${attempts}-failed`)
      }
      return 'ok'
    }, {maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2})
    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })

  it('exposes pending operation counters in snapshot', async () => {
    const mod = require('../index')
    const snapshot = mod.getBleScanSnapshot()
    expect(typeof snapshot.pendingOperationCount).toBe('number')
    expect(typeof snapshot.pendingOperationDeviceCount).toBe('number')
  })

  it('disposes runtime and recreates native instance on next use', async () => {
    const mod = require('../index')
    const nitro = require('react-native-nitro-modules')
    expect(nitro.__nitroMock.getInstanceCount()).toBe(1)
    mod.disposeBleRuntime()
    const disposedInstance = nitro.__nitroMock.getLastInstance()
    expect(disposedInstance.dispose).toHaveBeenCalledTimes(1)
    mod.getBleAdapterState()
    expect(nitro.__nitroMock.getInstanceCount()).toBe(2)
  })
})
