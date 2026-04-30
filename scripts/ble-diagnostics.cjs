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

function readJson(filePath) {
  const abs = path.resolve(process.cwd(), filePath)
  const text = fs.readFileSync(abs, 'utf8')
  return JSON.parse(text)
}

function pct(value) {
  return `${Math.round(value * 100)}%`
}

const args = parseArgs(process.argv.slice(2))
const reportPath = args.report
const tracePath = args.trace

if (!reportPath) {
  console.error(
    '[ble-diagnostics] Missing --report <path>. Use JSON from monitor.getReport().'
  )
  process.exit(1)
}

const report = readJson(reportPath)
const trace = tracePath ? readJson(tracePath) : []

console.log('=== BLE Runtime Diagnostics ===')
console.log(`Generated: ${new Date(report.generatedAtMs).toISOString()}`)
console.log('')
console.log('[Scan]')
console.log(`- Active: ${report.scan.isActive}`)
console.log(`- Sessions: ${report.scan.sessionCount}`)
console.log(`- Found devices (total): ${report.scan.foundDevicesTotal}`)
console.log(`- Warnings: ${report.scan.warningCount}`)
console.log(`- Errors: ${report.scan.errorCount}`)
if (Array.isArray(report.scan.topErrorCodes) && report.scan.topErrorCodes.length > 0) {
  console.log(
    `- Top error codes: ${report.scan.topErrorCodes
      .map((e) => `${e.code}(${e.count})`)
      .join(', ')}`
  )
}

console.log('')
console.log('[Connection]')
console.log(`- Attempts: ${report.connection.attempts}`)
console.log(`- Successes: ${report.connection.successes}`)
console.log(`- Failures: ${report.connection.failures}`)
console.log(`- Timeouts: ${report.connection.timeouts}`)
console.log(`- In-flight: ${report.connection.inFlight}`)
console.log(`- Avg connect latency: ${report.connection.avgConnectLatencyMs}ms`)
console.log(`- Avg GATT op latency: ${report.connection.avgGattOpLatencyMs}ms`)
console.log(`- GATT success rate: ${pct(report.connection.gattOpSuccessRate)}`)

if (Array.isArray(trace) && trace.length > 0) {
  const latest = trace.slice(Math.max(0, trace.length - 20))
  console.log('')
  console.log(`[Trace] showing ${latest.length}/${trace.length} latest entries`)
  latest.forEach((entry) => {
    console.log(
      `- ${new Date(entry.ts).toISOString()} ${entry.category}:${entry.name}` +
        `${entry.success == null ? '' : ` success=${entry.success}`}` +
        `${entry.details ? ` details=${entry.details}` : ''}`
    )
  })
}
