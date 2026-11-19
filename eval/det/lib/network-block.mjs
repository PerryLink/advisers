/**
 * Network-block preload for the deterministic eval suite.
 *
 * Loaded into every child CLI process via NODE_OPTIONS="--import=<this file>".
 * Any attempt to open a socket, resolve a host or call fetch is recorded to
 * ADVISERS_EVAL_NET_LOG and then rejected with E_EVAL_NETWORK. The runner
 * asserts the log stays empty, so "the det suite never touches the network"
 * is a checked property rather than a promise.
 *
 * Coverage: net.Socket.prototype.connect, net.connect/createConnection,
 * tls.connect/TLSSocket.connect, http(s).request/get, dns(.promises) lookups
 * and global fetch. Everything the product could use for egress goes through
 * one of these on Node 22/24.
 */
import { appendFileSync } from 'node:fs'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

const logPath = process.env.ADVISERS_EVAL_NET_LOG

function record(kind, detail) {
  if (!logPath) return
  try {
    appendFileSync(logPath, JSON.stringify({ kind: String(kind), detail: String(detail).slice(0, 200), pid: process.pid }) + '\n')
  } catch {
    // Recording must never change the child's own failure mode.
  }
}

function deny(kind, detail) {
  record(kind, detail)
  const error = new Error('E_EVAL_NETWORK: network access is blocked in the deterministic eval suite (' + kind + ')')
  error.code = 'E_EVAL_NETWORK'
  throw error
}

function patch(target, key, kind) {
  if (!target || typeof target[key] !== 'function' || target[key].__evalBlocked === true) return 0
  const wrapped = (...args) => deny(kind, args[0] === undefined ? '' : String(args[0]))
  wrapped.__evalBlocked = true
  target[key] = wrapped
  return 1
}

let patched = 0
if (net.Socket?.prototype && typeof net.Socket.prototype.connect === 'function') {
  net.Socket.prototype.connect = function blockedSocketConnect() {
    return deny('net.Socket.connect', 'socket')
  }
  patched += 1
}
patched += patch(net, 'connect', 'net.connect')
patched += patch(net, 'createConnection', 'net.createConnection')
patched += patch(tls, 'connect', 'tls.connect')
if (tls.TLSSocket?.prototype && typeof tls.TLSSocket.prototype.connect === 'function') {
  tls.TLSSocket.prototype.connect = function blockedTlsConnect() {
    return deny('tls.TLSSocket.connect', 'tls')
  }
  patched += 1
}
for (const method of ['request', 'get']) {
  patched += patch(http, method, 'http.' + method)
  patched += patch(https, method, 'https.' + method)
}
for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) {
  patched += patch(dns, method, 'dns.' + method)
  patched += patch(dns.promises, method, 'dns.promises.' + method)
}
globalThis.fetch = function blockedFetch(input) {
  return deny('fetch', String(input))
}

if (patched === 0) {
  throw new Error('E_EVAL_NETWORK_PRELOAD: no network entry point was patched; the preload is stale')
}
