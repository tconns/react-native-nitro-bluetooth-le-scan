import type { HybridObject } from 'react-native-nitro-modules'

export interface NitroBleScan
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  getAdapterState(): string
  ensurePermissions(): boolean
  setBluetoothEnabled(enable: boolean): boolean
  startScan(configJson: string): boolean
  stopScan(): boolean
  connect(deviceId: string, optionsJson: string): boolean
  disconnect(deviceId: string): boolean
  submitGattOperation(operationJson: string): boolean
  getSnapshot(): string
  setEventListener(listener: (eventJson: string) => void): void
}
