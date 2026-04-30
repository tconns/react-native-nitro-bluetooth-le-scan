import { NitroModules } from 'react-native-nitro-modules'
import type { NitroBleScan as NitroBleScanSpec } from './specs/NitroBleScan.nitro'

let instance: NitroBleScanSpec | null = null

export function getNitroBleScan(): NitroBleScanSpec {
  if (instance == null) {
    instance = NitroModules.createHybridObject<NitroBleScanSpec>('NitroBleScan')
  }
  return instance
}
