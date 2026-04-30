#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs')
const path = require('path')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[i + 1]
    if (value && !value.startsWith('--')) {
      out[key] = value
      i += 1
    } else {
      out[key] = 'true'
    }
  }
  return out
}

function toComponentName(raw) {
  const cleaned = raw.replace(/[^a-zA-Z0-9]+/g, ' ')
  const words = cleaned
    .split(' ')
    .map((w) => w.trim())
    .filter(Boolean)
  if (words.length === 0) return 'BleDashboardScreen'
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')
}

const args = parseArgs(process.argv.slice(2))
const name = toComponentName(args.name || 'BleDashboardScreen')
const outputDir = path.resolve(process.cwd(), args.output || './src/screens')
const outputFile = path.join(outputDir, `${name}.tsx`)

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, {recursive: true})
}

if (fs.existsSync(outputFile)) {
  console.error(`[ble-scaffold] Refusing to overwrite existing file: ${outputFile}`)
  process.exit(1)
}

const content = `import React from 'react'
import {Pressable, SafeAreaView, StyleSheet, Text, View} from 'react-native'
import {
  useBleAdapterState,
  useBlePermissions,
  useBleScan,
} from 'react-native-nitro-bluetooth-le-scan'

export function ${name}() {
  const {adapterState, refresh} = useBleAdapterState()
  const {granted, loading, ensure} = useBlePermissions()
  const {isScanning, devices, start, stop, clear} = useBleScan()

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>${name}</Text>
      <Text style={styles.meta}>Adapter: {adapterState}</Text>
      <Text style={styles.meta}>Permission: {granted ? 'granted' : 'unknown'}</Text>
      <Text style={styles.meta}>Devices: {devices.length}</Text>
      <View style={styles.row}>
        <Pressable style={styles.button} onPress={() => void ensure()}>
          <Text style={styles.buttonText}>{loading ? 'Checking...' : 'Ensure Permission'}</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={() => void start()}>
          <Text style={styles.buttonText}>{isScanning ? 'Scanning...' : 'Start'}</Text>
        </Pressable>
      </View>
      <View style={styles.row}>
        <Pressable style={styles.button} onPress={() => void stop()}>
          <Text style={styles.buttonText}>Stop</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={refresh}>
          <Text style={styles.buttonText}>Refresh Adapter</Text>
        </Pressable>
      </View>
      <Pressable style={styles.button} onPress={clear}>
        <Text style={styles.buttonText}>Clear Cache</Text>
      </Pressable>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {flex: 1, padding: 16, backgroundColor: '#fff'},
  title: {fontSize: 22, fontWeight: '700', marginBottom: 8},
  meta: {fontSize: 13, color: '#374151', marginBottom: 4},
  row: {flexDirection: 'row', gap: 8, marginTop: 10},
  button: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#2563eb',
    alignItems: 'center',
  },
  buttonText: {color: '#fff', fontWeight: '600'},
})
`

fs.writeFileSync(outputFile, content, 'utf8')
console.log(`[ble-scaffold] Created ${outputFile}`)
