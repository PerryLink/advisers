/**
 * Default (zh-CN) label table for the 0.3.0 output kernel.
 *
 * 0.3.0 ships Simplified Chinese human-facing text. This table is the kernel's single
 * place for display words so callers can inject a different table (tests use it to
 * prove no bare literals leak into render logic) and so the 0.3.2 i18n seam can
 * re-export or replace it without touching render.js.
 *
 * Machine-facing strings (command names, flags, JSON keys, error codes) are English
 * and never live here.
 */
export const DEFAULT_LABELS = Object.freeze({
  userPrefix: '> ',
  itemPrefix: '  - ',
  indent: '  ',
  filePrefix: '  文件：',
  checkPrefix: '  校验：',
  warningPrefix: '  ! ',
  nextPrefix: '  下一步：',
  errorPrefix: '! 没做成：',
  confirmPrefix: '! 需要确认：',
  reasonPrefix: '  原因：',
  keptPrefix: '  已保留：',
  writePrefix: '  写入：',
  summaryPrefix: '  摘要：',
  digestPrefix: '  摘要：',
  codePrefix: '  代码：',
  confirmPrompt: 'y 写入 / n 取消（默认 n）',
  statusSeparator: ' · ',
  statusAccessiblePrefix: '[状态] ',
  statusReady: '就绪',
  statusBusy: (seconds) => `工作中 ${seconds}s · Esc 中断`,
  statusBusyNoTimer: '工作中 · Esc 中断',
  statusConfirm: '待确认 · y 写入 / n 取消（默认 n）',
  statusError: (reason) => `上次失败：${reason} · /retry`,
  statusUnknownReason: '未记录',
  statusOffline: '模型不可达（上次失败） · /status',
  statusLocalModel: '本地模式',
  statusHelpHint: '/help',
  statusToday: (due, overdue) => `今天 ${due} 件到期 / ${overdue} 件逾期`,
  statusTodayClear: '今天没有到期项',
  overflowItems: (count) => `  …（+${count} 条，/more 或 --json 查看）`,
  overflowLines: (count) => `  …（+${count} 行，/more 或 --json 查看）`,
  warningOverflow: (count) => `（+${count} 条）`,
  verboseTool: (name, ok) => `  · ${name} ${ok ? 'ok' : 'FAILED'}`,
  verboseDuration: (duration) => `  耗时：${duration}`,
  artifactBytes: (bytes) => bytes,
  snapshotTitle: 'Advisers TUI',
})

