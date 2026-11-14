/**
 * E1-T3: best-effort local notification adapter.
 *
 * No cloud push. The caller decides the body; Advisers only sends a short
 * count-style body (not client names/quotes). If no channel is available the
 * caller keeps the local reminder log; this module reports `sent:false`.
 */
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

function run(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs, windowsHide: true })
    let err = ''
    child.stderr.on('data', (b) => { err += b.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(0, 200)}`)))
  })
}

function powershellToastScript(title, body) {
  const q = (s) => String(s).replace(/'/g, "''")
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$n = $t.GetElementsByTagName('text')",
    `$n.Item(0).AppendChild($t.CreateTextNode('${q(title)}')) | Out-Null`,
    `$n.Item(1).AppendChild($t.CreateTextNode('${q(body)}')) | Out-Null`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($t)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Advisers').Show($toast)",
  ].join('; ')
}

export async function sendNotification({ title = 'Advisers', body = '', cmd = process.env.ADVISERS_NOTIFY_CMD } = {}) {
  if (cmd) {
    await run(cmd, [title, body])
    return { sent: true, channel: 'custom' }
  }
  const platform = process.platform
  try {
    if (platform === 'darwin') {
      await run('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`])
      return { sent: true, channel: 'osascript' }
    }
    if (platform === 'linux') {
      if (process.env.WSL_DISTRO_NAME && existsSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')) {
        await run('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershellToastScript(title, body)])
        return { sent: true, channel: 'wsl-toast' }
      }
      const candidates = ['/usr/bin/notify-send', '/bin/notify-send']
      const found = candidates.find((p) => existsSync(p))
      if (found) { await run(found, [title, body]); return { sent: true, channel: 'notify-send' } }
      return { sent: false, channel: 'none' }
    }
    if (platform === 'win32') {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershellToastScript(title, body)])
      return { sent: true, channel: 'windows-toast' }
    }
    return { sent: false, channel: 'none' }
  } catch {
    return { sent: false, channel: 'error' }
  }
}
