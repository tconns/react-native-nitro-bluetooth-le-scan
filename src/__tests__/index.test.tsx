jest.mock('react-native-nitro-modules', () => ({
  NitroModules: {
    createHybridObject: () => ({
      getAdapterState: () => 'poweredOn',
      ensurePermissions: () => true,
      startScan: () => true,
      stopScan: () => true,
      connect: () => true,
      disconnect: () => true,
      discoverServices: () => '[]',
      readCharacteristic: () => '[]',
      writeCharacteristic: () => true,
      setCharacteristicNotification: () => true,
      getSnapshot: () => '{"isScanning":false,"adapterState":"poweredOn","seenDeviceCount":0,"eventsEmitted":0,"eventsDropped":0,"coalescedCount":0}',
      setEventListener: () => undefined,
    }),
  },
}))

describe('react-native-nitro-bluetooth-le-scan', () => {
  it('exports runtime symbols', () => {
    const mod = require('../index')
    expect(typeof mod.startBleScan).toBe('function')
    expect(typeof mod.stopBleScan).toBe('function')
    expect(typeof mod.getBleScanSnapshot).toBe('function')
    expect(typeof mod.subscribeBleScan).toBe('function')
    expect(typeof mod.rankDevices).toBe('function')
    expect(typeof mod.estimateDistance).toBe('function')
    expect(typeof mod.registerManufacturerParser).toBe('function')
    expect(typeof mod.connectBleDevice).toBe('function')
    expect(typeof mod.discoverBleServices).toBe('function')
    expect(typeof mod.disconnectBleDevice).toBe('function')
    expect(typeof mod.safeConnect).toBe('function')
    expect(typeof mod.readWithRetry).toBe('function')
    expect(typeof mod.createNotificationManager).toBe('function')
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
})
