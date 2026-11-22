/**
 * In-process fake transport + socket guard for the model-contract gate.
 *
 * The model-optional paths accept a `fetchImpl` seam (lib/model.js, lib/capture.js,
 * lib/mail-extract.js), so every case can drive the real product code with a
 * deterministic stub: no API key, no network socket, no real model. The socket
 * guard patches every Node egress entry point and counts any attempt, so
 * "0 sockets" is asserted rather than promised.
 */
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

/**
 * Build a recording fetch implementation.
 * @param {(callNumber:number, request:{url:string,body:any})=>Promise<any>} handler
 */
export function recordingTransport(handler) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    let body = null
    if (typeof options?.body === 'string') {
      try { body = JSON.parse(options.body) } catch { body = options.body }
    }
    const request = { url: String(url), method: String(options?.method ?? 'GET'), body, headers: options?.headers ?? {}, signal: options?.signal }
    calls.push(request)
    return handler(calls.length, request)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

/** One minimal OpenAI-compatible HTTP response. */
export function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload },
    async text() { return JSON.stringify(payload) },
  }
}

/** A successful chat completion response with one assistant message. */
export function chatResponse(content, { finishReason = 'stop', usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } = {}) {
  return jsonResponse({ choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }], usage })
}

/** A capture-model response whose content is the given candidate JSON. */
export function captureResponse(candidates) {
  return chatResponse(JSON.stringify({ candidates }))
}

/**
 * Patch every Node network entry point with a counting, throwing guard.
 * Returns `{ attempts, restore() }`; call restore() in a finally block.
 */
export function installSocketGuard() {
  const attempts = []
  const restores = []
  const deny = (kind, detail) => {
    attempts.push({ kind, detail: String(detail ?? '').slice(0, 120) })
    const error = new Error('E_EVAL_SOCKET: network access is blocked in the model-contract gate (' + kind + ')')
    error.code = 'E_EVAL_SOCKET'
    throw error
  }
  const patch = (target, key, kind) => {
    if (!target || typeof target[key] !== 'function' || target[key].__evalSocketGuard === true) return
    const original = target[key]
    const wrapped = function guardedEgress(...args) { return deny(kind, args[0]) }
    wrapped.__evalSocketGuard = true
    target[key] = wrapped
    restores.push(() => { target[key] = original })
  }
  if (net.Socket?.prototype) {
    const original = net.Socket.prototype.connect
    net.Socket.prototype.connect = function guardedSocketConnect() { return deny('net.Socket.connect', 'socket') }
    restores.push(() => { net.Socket.prototype.connect = original })
  }
  patch(net, 'connect', 'net.connect')
  patch(net, 'createConnection', 'net.createConnection')
  patch(tls, 'connect', 'tls.connect')
  if (tls.TLSSocket?.prototype) {
    const original = tls.TLSSocket.prototype.connect
    tls.TLSSocket.prototype.connect = function guardedTlsConnect() { return deny('tls.TLSSocket.connect', 'tls') }
    restores.push(() => { tls.TLSSocket.prototype.connect = original })
  }
  for (const method of ['request', 'get']) {
    patch(http, method, 'http.' + method)
    patch(https, method, 'https.' + method)
  }
  for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
    patch(dns, method, 'dns.' + method)
    patch(dns.promises, method, 'dns.promises.' + method)
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = function guardedFetch(input) { return deny('fetch', String(input)) }
  restores.push(() => { globalThis.fetch = originalFetch })
  return {
    attempts,
    restore() { for (const restore of restores.reverse()) { try { restore() } catch {} } },
  }
}

