import type { HybridObject } from 'react-native-nitro-modules'

export interface NitroBleScan
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  getAdapterState(): string
  ensurePermissions(): boolean
  startScan(configJson: string): boolean
  stopScan(): boolean
  connect(deviceId: string, optionsJson: string): boolean
  disconnect(deviceId: string): boolean
  discoverServices(deviceId: string): string
  readCharacteristic(addressJson: string): string
  writeCharacteristic(addressJson: string, valueJson: string): boolean
  setCharacteristicNotification(addressJson: string, enable: boolean): boolean
  getSnapshot(): string
  setEventListener(listener: (eventJson: string) => void): void
}
