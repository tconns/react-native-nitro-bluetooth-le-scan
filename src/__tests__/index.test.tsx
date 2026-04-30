jest.mock('react-native-nitro-modules', () => ({
  NitroModules: {
    createHybridObject: () => ({
      getAdapterState: () => 'poweredOn',
      ensurePermissions: () => true,
      startScan: () => true,
      stopScan: () => true,
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
})
