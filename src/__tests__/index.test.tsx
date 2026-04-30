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
  })
})
