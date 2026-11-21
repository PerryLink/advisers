import assert from 'node:assert/strict'
import test from 'node:test'

import {
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  MODERN_CACHE_HINTS,
  MODERN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  RESOURCE_URIS,
  SUPPORTED_MODERN_PROTOCOL_VERSIONS,
  TOOL_NAMES,
  createMcpServer,
  resolveModernEnabled,
} from '../lib/mcp-server.js'

/**
 * 0.4.0 MCP modern (2026-07-28) dual-era tests.
 *
 * Legacy byte-stability is frozen as a golden session: the same fixture and the
 * same raw stdio request lines must produce the same response lines as the 0.3.2
 * server, both with the modern era enabled (default) and disabled.
 *
 * The modern era is additive: same read models, same audit, same clearance and
 * output caps; only the result envelope changes (resultType / cache hints /
 * serverInfo `_meta`) and the era-specific error mapping (-32602 resource,
 * -32022 version).
 */

const NOW = () => new Date('2026-11-21T02:00:00.000Z')
const SERVER_VERSION = '0.4.0-test'
const MODERN_META = Object.freeze({ [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION, [META_CLIENT_CAPABILITIES]: {} })

const MATTERS = {
  m_1: { id: 'm_1', title: '客户 A 报价', secrecy: 0 },
  m_2: { id: 'm_2', title: '机密项目', secrecy: 3 },
}
const ROWS = [
  { id: 'cm_1', matterId: 'm_1', debtor: 'user', creditor: '王工', action: '发送修订报价单', dueAt: '2026-11-21T18:00:00+08:00', status: 'open', capability: 'todo', evidence: [{ sessionId: 's1', turnId: 't1', quote: '周一前发修订报价单' }] },
  { id: 'cm_2', matterId: 'm_1', debtor: 'third:王工', creditor: 'user', action: '确认合同条款', dueAt: '2026-11-22T10:00:00+08:00', status: 'open', capability: 'todo', evidence: [] },
  { id: 'cm_3', matterId: 'm_1', debtor: 'user', creditor: '李总', action: '已完成的历史承诺', dueAt: '2026-11-20T10:00:00+08:00', status: 'done', capability: 'todo', evidence: [] },
  { id: 'cm_4', matterId: 'm_2', debtor: 'user', creditor: '某人', action: '机密承诺', dueAt: '2026-11-21T12:00:00+08:00', status: 'open', capability: 'todo', evidence: [] },
]

function ledgerFixture() {
  return {
    openCommitments: () => ROWS.filter((row) => row.status === 'open'),
    listCommitments: () => ROWS,
    getMatter: (id) => MATTERS[id],
    listMatters: () => Object.values(MATTERS),
    listFacts: () => [],
    listPreferences: () => [],
  }
}

function createFixture(options = {}) {
  const audits = []
  const server = createMcpServer({
    ledger: ledgerFixture(),
    version: SERVER_VERSION,
    audit: (entry) => { audits.push(entry) },
    now: NOW,
    ...options,
  })
  const call = (method, params, id = 1) => server.handle({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
  const notify = (method, params) => server.handle({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  const modernParams = (params = {}, meta = MODERN_META) => ({ ...params, _meta: meta })
  return { server, audits, call, notify, modernParams }
}

function payloadOf(response) {
  return JSON.parse(response.result.content[0].text)
}

/** Frozen 0.3.2 legacy stdio session (captured before the modern era layer). */
const LEGACY_GOLDEN = {
  "requests": [
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"golden\",\"version\":\"1\"}}}",
    "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}",
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2099-01-01\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"ping\"}",
    "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/list\"}",
    "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"advisers_today\",\"arguments\":{}}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"advisers_commit_ls\",\"arguments\":{}}}",
    "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"tools/call\",\"params\":{\"name\":\"advisers_commit_ls\",\"arguments\":{\"all\":true,\"limit\":2}}}",
    "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/call\",\"params\":{\"name\":\"advisers_who\",\"arguments\":{}}}",
    "{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"tools/call\",\"params\":{\"name\":\"advisers_remind\",\"arguments\":{}}}",
    "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"resources/list\"}",
    "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"resources/read\",\"params\":{\"uri\":\"advisers://today\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":13,\"method\":\"resources/read\",\"params\":{\"uri\":\"advisers://commitments\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":14,\"method\":\"resources/read\",\"params\":{\"uri\":\"advisers://who\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":15,\"method\":\"resources/read\",\"params\":{\"uri\":\"advisers://does-not-exist\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":16,\"method\":\"server/discover\",\"params\":{}}",
    "{\"jsonrpc\":\"2.0\",\"id\":17,\"method\":\"does/not/exist\",\"params\":{}}",
    "{\"jsonrpc\":\"2.0\",\"id\":18,\"method\":\"tools/call\",\"params\":{\"name\":\"no_such_tool\",\"arguments\":{}}}",
    "{\"jsonrpc\":\"2.0\",\"id\":19,\"method\":\"tools/call\",\"params\":{\"name\":\"advisers_commit_ls\",\"arguments\":{\"limit\":999}}}",
    "{\"jsonrpc\":\"2.0\",\"id\":20,\"method\":\"tools/call\",\"params\":{\"name\":\"advisers_evidence\",\"arguments\":{\"id\":\"zzz\"}}}",
    "{\"jsonrpc\":\"2.0\",\"id\":21}",
    "not json"
  ],
  "responses": [
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{\"tools\":{\"listChanged\":false},\"resources\":{\"subscribe\":false,\"listChanged\":false}},\"serverInfo\":{\"name\":\"advisers\",\"version\":\"0.4.0-test\"}}}",
    null,
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{\"tools\":{\"listChanged\":false},\"resources\":{\"subscribe\":false,\"listChanged\":false}},\"serverInfo\":{\"name\":\"advisers\",\"version\":\"0.4.0-test\"}}}",
    "{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{\"tools\":{\"listChanged\":false},\"resources\":{\"subscribe\":false,\"listChanged\":false}},\"serverInfo\":{\"name\":\"advisers\",\"version\":\"0.4.0-test\"}}}",
    "{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{}}",
    "{\"jsonrpc\":\"2.0\",\"id\":5,\"result\":{\"tools\":[{\"name\":\"advisers_today\",\"description\":\"Read the open-commitment count and the open commitments (read-only). Returns at most 20 commitment rows; `open`/`total` are the true post-clearance count and `truncated` says rows were withheld. Records belonging to protected matters (matter secrecy above this server clearance, default 0) are excluded and only counted in protectedExcluded.\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}},\"annotations\":{\"readOnlyHint\":true,\"destructiveHint\":false,\"idempotentHint\":true,\"openWorldHint\":false}},{\"name\":\"advisers_commit_ls\",\"description\":\"List commitments (open by default; pass all=true for every status). Returns {commitments, total, truncated, limit, clearance, protectedExcluded}; total is the post-clearance row count, so a truncated result is never mistaken for the whole ledger. Read-only. Records belonging to protected matters (matter secrecy above this server clearance, default 0) are excluded and only counted in protectedExcluded.\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"all\":{\"type\":\"boolean\",\"description\":\"Include done/snoozed/dropped commitments.\"},\"limit\":{\"type\":\"integer\",\"minimum\":1,\"maximum\":200,\"description\":\"Max rows to return (default 50, max 200).\"}}},\"annotations\":{\"readOnlyHint\":true,\"destructiveHint\":false,\"idempotentHint\":true,\"openWorldHint\":false}},{\"name\":\"advisers_who\",\"description\":\"Who owes whom: mine (user/agent) versus waiting (third parties). Read-only. Each array is capped at 20 rows; mineTotal/waitingTotal/truncated report the full counts. Records belonging to protected matters (matter secrecy above this server clearance, default 0) are excluded and only counted in protectedExcluded.\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}},\"annotations\":{\"readOnlyHint\":true,\"destructiveHint\":false,\"idempotentHint\":true,\"openWorldHint\":false}},{\"name\":\"advisers_evidence\",\"description\":\"Read the source turns for a commitment/fact/preference id. Read-only. Evidence of a protected record is withheld (no id content) and reported as protectedExcluded.\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\",\"description\":\"cm_* commitment, fact_* fact, or pref_* preference id.\"}},\"required\":[\"id\"]},\"annotations\":{\"readOnlyHint\":true,\"destructiveHint\":false,\"idempotentHint\":true,\"openWorldHint\":false}},{\"name\":\"advisers_remind\",\"description\":\"Read due reminders (no delivery, no network). Returns {reminders, total, truncated, clearance, protectedExcluded}; total is the post-clearance reminder count. Read-only. Records belonging to protected matters (matter secrecy above this server clearance, default 0) are excluded and only counted in protectedExcluded.\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}},\"annotations\":{\"readOnlyHint\":true,\"destructiveHint\":false,\"idempotentHint\":true,\"openWorldHint\":false}},{\"name\":\"advisers_clients\",\"description\":\"Read-only customer projection: list active clients (all=true includes archived) or show one client by id. Rows carry exact counts, nextDueAt, clearance and protectedExcluded; show adds project summaries, open mine/waiting items and a derived delivery/commitment timeline. Note text and conversation bodies are never returned. At most 20 client rows are returned (limit 1..50); timelineLimit (1..50) caps the show timeline. Records belonging to protected matters (matter secrecy above this server clearance, default 0) are excluded and only counted in protectedExcluded.\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"action\":{\"type\":\"string\",\"enum\":[\"list\",\"show\"],\"description\":\"list: client rows; show: one client view.\"},\"id\":{\"type\":\"string\",\"description\":\"Client id (cl_…). Required when action is show.\"},\"all\":{\"type\":\"boolean\",\"description\":\"Include archived clients (action=list).\"},\"limit\":{\"type\":\"integer\",\"minimum\":1,\"maximum\":50,\"description\":\"Max client rows for action=list (default 20, max 50).\"},\"timelineLimit\":{\"type\":\"integer\",\"minimum\":1,\"maximum\":50,\"description\":\"Max timeline rows for action=show (default 20, max 50).\"}},\"required\":[\"action\"]},\"annotations\":{\"readOnlyHint\":true,\"destructiveHint\":false,\"idempotentHint\":true,\"openWorldHint\":false}},{\"name\":\"advisers_capture_candidate\",\"description\":\"Propose a PENDING commitment candidate captured from a quote. This writes a memory candidate only: it never accepts the candidate and never changes the ledger. A human must review it with \\\"advisers memory candidates\\\" and run \\\"advisers memory accept <id>\\\".\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"action\":{\"type\":\"string\",\"minLength\":1,\"maxLength\":500,\"description\":\"What must be done (verbatim or near-verbatim).\"},\"quote\":{\"type\":\"string\",\"minLength\":1,\"maxLength\":2000,\"description\":\"The verbatim source text this candidate was captured from.\"},\"debtor\":{\"type\":\"string\",\"enum\":[\"user\",\"agent\",\"third\"],\"description\":\"Who owes the action. Defaults to user.\"},\"creditor\":{\"type\":\"string\",\"maxLength\":200,\"description\":\"Who is owed the action. Defaults to someone.\"},\"dueAt\":{\"type\":\"string\",\"maxLength\":64,\"description\":\"ISO 8601 due date-time, e.g. 2026-12-01T10:00:00+08:00.\"},\"matterId\":{\"type\":\"string\",\"maxLength\":120,\"description\":\"Existing matter id. Defaults to the first active matter.\"}},\"required\":[\"action\",\"quote\"],\"additionalProperties\":false},\"annotations\":{\"readOnlyHint\":false,\"destructiveHint\":false,\"idempotentHint\":false,\"openWorldHint\":false}},{\"name\":\"advisers_pack_verify\",\"description\":\"Read-only verification of an evidence-pack receipt directory: recomputes SHA256SUMS for manifest.json and README.txt, rejects unsafe or unhashed pack files, and reports whether a receipt.docx is present. Never modifies the directory. The directory path is not echoed in errors.\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"dir\":{\"type\":\"string\",\"minLength\":1,\"maxLength\":4096,\"description\":\"Directory written by \\\"advisers deliveries --pack\\\" (contains manifest.json, README.txt, SHA256SUMS, optionally receipt.docx).\"}},\"required\":[\"dir\"],\"additionalProperties\":false},\"annotations\":{\"readOnlyHint\":true,\"destructiveHint\":false,\"idempotentHint\":true,\"openWorldHint\":false}}]}}",
    "{\"jsonrpc\":\"2.0\",\"id\":6,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"open\\\": 2,\\n  \\\"commitments\\\": [\\n    {\\n      \\\"id\\\": \\\"cm_1\\\",\\n      \\\"debtor\\\": \\\"user\\\",\\n      \\\"creditor\\\": \\\"王工\\\",\\n      \\\"action\\\": \\\"发送修订报价单\\\",\\n      \\\"dueAt\\\": \\\"2026-11-21T18:00:00+08:00\\\"\\n    },\\n    {\\n      \\\"id\\\": \\\"cm_2\\\",\\n      \\\"debtor\\\": \\\"third:王工\\\",\\n      \\\"creditor\\\": \\\"user\\\",\\n      \\\"action\\\": \\\"确认合同条款\\\",\\n      \\\"dueAt\\\": \\\"2026-11-22T10:00:00+08:00\\\"\\n    }\\n  ],\\n  \\\"clearance\\\": 0,\\n  \\\"protectedExcluded\\\": 1,\\n  \\\"total\\\": 2,\\n  \\\"truncated\\\": false\\n}\"}],\"isError\":false}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"commitments\\\": [\\n    {\\n      \\\"id\\\": \\\"cm_1\\\",\\n      \\\"status\\\": \\\"open\\\",\\n      \\\"action\\\": \\\"发送修订报价单\\\",\\n      \\\"dueAt\\\": \\\"2026-11-21T18:00:00+08:00\\\",\\n      \\\"creditor\\\": \\\"王工\\\"\\n    },\\n    {\\n      \\\"id\\\": \\\"cm_2\\\",\\n      \\\"status\\\": \\\"open\\\",\\n      \\\"action\\\": \\\"确认合同条款\\\",\\n      \\\"dueAt\\\": \\\"2026-11-22T10:00:00+08:00\\\",\\n      \\\"creditor\\\": \\\"user\\\"\\n    }\\n  ],\\n  \\\"clearance\\\": 0,\\n  \\\"protectedExcluded\\\": 1,\\n  \\\"total\\\": 2,\\n  \\\"truncated\\\": false,\\n  \\\"limit\\\": 50\\n}\"}],\"isError\":false}}",
    "{\"jsonrpc\":\"2.0\",\"id\":8,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"commitments\\\": [\\n    {\\n      \\\"id\\\": \\\"cm_1\\\",\\n      \\\"status\\\": \\\"open\\\",\\n      \\\"action\\\": \\\"发送修订报价单\\\",\\n      \\\"dueAt\\\": \\\"2026-11-21T18:00:00+08:00\\\",\\n      \\\"creditor\\\": \\\"王工\\\"\\n    },\\n    {\\n      \\\"id\\\": \\\"cm_2\\\",\\n      \\\"status\\\": \\\"open\\\",\\n      \\\"action\\\": \\\"确认合同条款\\\",\\n      \\\"dueAt\\\": \\\"2026-11-22T10:00:00+08:00\\\",\\n      \\\"creditor\\\": \\\"user\\\"\\n    }\\n  ],\\n  \\\"clearance\\\": 0,\\n  \\\"protectedExcluded\\\": 1,\\n  \\\"total\\\": 3,\\n  \\\"truncated\\\": true,\\n  \\\"limit\\\": 2\\n}\"}],\"isError\":false}}",
    "{\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"mine\\\": [\\n    {\\n      \\\"id\\\": \\\"cm_1\\\",\\n      \\\"matterId\\\": \\\"m_1\\\",\\n      \\\"debtor\\\": \\\"user\\\",\\n      \\\"creditor\\\": \\\"王工\\\",\\n      \\\"action\\\": \\\"发送修订报价单\\\",\\n      \\\"dueAt\\\": \\\"2026-11-21T18:00:00+08:00\\\",\\n      \\\"status\\\": \\\"open\\\",\\n      \\\"capability\\\": \\\"todo\\\",\\n      \\\"evidence\\\": [\\n        {\\n          \\\"sessionId\\\": \\\"s1\\\",\\n          \\\"turnId\\\": \\\"t1\\\",\\n          \\\"quote\\\": \\\"周一前发修订报价单\\\"\\n        }\\n      ]\\n    }\\n  ],\\n  \\\"waiting\\\": [\\n    {\\n      \\\"id\\\": \\\"cm_2\\\",\\n      \\\"matterId\\\": \\\"m_1\\\",\\n      \\\"debtor\\\": \\\"third:王工\\\",\\n      \\\"creditor\\\": \\\"user\\\",\\n      \\\"action\\\": \\\"确认合同条款\\\",\\n      \\\"dueAt\\\": \\\"2026-11-22T10:00:00+08:00\\\",\\n      \\\"status\\\": \\\"open\\\",\\n      \\\"capability\\\": \\\"todo\\\",\\n      \\\"evidence\\\": []\\n    }\\n  ],\\n  \\\"clearance\\\": 0,\\n  \\\"protectedExcluded\\\": 1,\\n  \\\"mineTotal\\\": 1,\\n  \\\"waitingTotal\\\": 1,\\n  \\\"truncated\\\": false\\n}\"}],\"isError\":false}}",
    "{\"jsonrpc\":\"2.0\",\"id\":10,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"reminders\\\": [\\n    {\\n      \\\"commitmentId\\\": \\\"cm_1\\\",\\n      \\\"action\\\": \\\"发送修订报价单\\\",\\n      \\\"dueAt\\\": \\\"2026-11-21T18:00:00+08:00\\\",\\n      \\\"bucket\\\": \\\"due-today\\\",\\n      \\\"level\\\": \\\"L2\\\",\\n      \\\"ruleId\\\": \\\"due-today-09\\\"\\n    },\\n    {\\n      \\\"commitmentId\\\": \\\"cm_2\\\",\\n      \\\"action\\\": \\\"确认合同条款\\\",\\n      \\\"dueAt\\\": \\\"2026-11-22T10:00:00+08:00\\\",\\n      \\\"bucket\\\": \\\"due-1d\\\",\\n      \\\"level\\\": \\\"L1\\\",\\n      \\\"ruleId\\\": \\\"due-1d\\\"\\n    }\\n  ],\\n  \\\"clearance\\\": 0,\\n  \\\"protectedExcluded\\\": 1,\\n  \\\"total\\\": 2,\\n  \\\"truncated\\\": false\\n}\"}],\"isError\":false}}",
    "{\"jsonrpc\":\"2.0\",\"id\":11,\"result\":{\"resources\":[{\"uri\":\"advisers://today\",\"name\":\"today\",\"description\":\"Open commitments and their count (same shape as advisers_today; protected matters excluded at the server clearance).\",\"mimeType\":\"application/json\"},{\"uri\":\"advisers://commitments\",\"name\":\"commitments\",\"description\":\"All commitments (open and closed) as compact rows.\",\"mimeType\":\"application/json\"},{\"uri\":\"advisers://who\",\"name\":\"who\",\"description\":\"Who owes whom: mine (user/agent) vs waiting (third parties).\",\"mimeType\":\"application/json\"},{\"uri\":\"advisers://evidence\",\"name\":\"evidence\",\"description\":\"Evidence traceback index for commitments, facts and preferences (counts only).\",\"mimeType\":\"application/json\"},{\"uri\":\"advisers://clients\",\"name\":\"clients\",\"description\":\"Active client rows as compact read-only projections (exact counts and next due date; no note text or conversation bodies), capped with total/truncated/limit and clearance/protectedExcluded.\",\"mimeType\":\"application/json\"}]}}",
    "{\"jsonrpc\":\"2.0\",\"id\":12,\"result\":{\"contents\":[{\"uri\":\"advisers://today\",\"mimeType\":\"application/json\",\"text\":\"{\\n  \\\"open\\\": 2,\\n  \\\"commitments\\\": [\\n    {\\n      \\\"id\\\": \\\"cm_1\\\",\\n      \\\"debtor\\\": \\\"user\\\",\\n      \\\"creditor\\\": \\\"王工\\\",\\n      \\\"action\\\": \\\"发送修订报价单\\\",\\n      \\\"dueAt\\\": \\\"2026-11-21T18:00:00+08:00\\\"\\n    },\\n    {\\n      \\\"id\\\": \\\"cm_2\\\",\\n      \\\"debtor\\\": \\\"third:王工\\\",\\n      \\\"creditor\\\": \\\"user\\\",\\n      \\\"action\\\": \\\"确认合同条款\\\",\\n      \\\"dueAt\\\": \\\"2026-11-22T10:00:00+08:00\\\"\\n    }\\n  ],\\n  \\\"clearance\\\": 0,\\n  \\\"protectedExcluded\\\": 1,\\n  \\\"total\\\": 2,\\n  \\\"truncated\\\": false\\n}\"}]}}",
    "{\"jsonrpc\":\"2.0\",\"id\":13,\"result\":{\"contents\":[{\"uri\":\"advisers://commitments\",\"mimeType\":\"application/json\",\"text\":\"{\\n  \\\"commitments\\\": [\\n    {\\n      \\\"id\\\": \\\"cm_1\\\",\\n      \\\"status\\\": \\\"open\\\",\\n      \\\"action\\\": \\\"发送修订报价单\\\",\\n      \\\"dueAt\\\": \\\"2026-11-21T18:00:00+08:00\\\",\\n      \\\"creditor\\\": \\\"王工\\\"\\n    },\\n    {\\n      \\\"id\\\": \\\"cm_2\\\",\\n      \\\"status\\\": \\\"open\\\",\\n      \\\"action\\\": \\\"确认合同条款\\\",\\n      \\\"dueAt\\\": \\\"2026-11-22T10:00:00+08:00\\\",\\n      \\\"creditor\\\": \\\"user\\\"\\n    },\\n    {\\n      \\\"id\\\": \\\"cm_3\\\",\\n      \\\"status\\\": \\\"done\\\",\\n      \\\"action\\\": \\\"已完成的历史承诺\\\",\\n      \\\"dueAt\\\": \\\"2026-11-20T10:00:00+08:00\\\",\\n      \\\"creditor\\\": \\\"李总\\\"\\n    }\\n  ],\\n  \\\"clearance\\\": 0,\\n  \\\"protectedExcluded\\\": 1,\\n  \\\"total\\\": 3,\\n  \\\"truncated\\\": false,\\n  \\\"limit\\\": 50\\n}\"}]}}",
    "{\"jsonrpc\":\"2.0\",\"id\":14,\"result\":{\"contents\":[{\"uri\":\"advisers://who\",\"mimeType\":\"application/json\",\"text\":\"{\\n  \\\"mine\\\": [\\n    {\\n      \\\"id\\\": \\\"cm_1\\\",\\n      \\\"matterId\\\": \\\"m_1\\\",\\n      \\\"debtor\\\": \\\"user\\\",\\n      \\\"creditor\\\": \\\"王工\\\",\\n      \\\"action\\\": \\\"发送修订报价单\\\",\\n      \\\"dueAt\\\": \\\"2026-11-21T18:00:00+08:00\\\",\\n      \\\"status\\\": \\\"open\\\",\\n      \\\"capability\\\": \\\"todo\\\",\\n      \\\"evidence\\\": [\\n        {\\n          \\\"sessionId\\\": \\\"s1\\\",\\n          \\\"turnId\\\": \\\"t1\\\",\\n          \\\"quote\\\": \\\"周一前发修订报价单\\\"\\n        }\\n      ]\\n    }\\n  ],\\n  \\\"waiting\\\": [\\n    {\\n      \\\"id\\\": \\\"cm_2\\\",\\n      \\\"matterId\\\": \\\"m_1\\\",\\n      \\\"debtor\\\": \\\"third:王工\\\",\\n      \\\"creditor\\\": \\\"user\\\",\\n      \\\"action\\\": \\\"确认合同条款\\\",\\n      \\\"dueAt\\\": \\\"2026-11-22T10:00:00+08:00\\\",\\n      \\\"status\\\": \\\"open\\\",\\n      \\\"capability\\\": \\\"todo\\\",\\n      \\\"evidence\\\": []\\n    }\\n  ],\\n  \\\"clearance\\\": 0,\\n  \\\"protectedExcluded\\\": 1,\\n  \\\"mineTotal\\\": 1,\\n  \\\"waitingTotal\\\": 1,\\n  \\\"truncated\\\": false\\n}\"}]}}",
    "{\"jsonrpc\":\"2.0\",\"id\":15,\"error\":{\"code\":-32002,\"message\":\"resource not found\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":16,\"error\":{\"code\":-32601,\"message\":\"unknown method\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":17,\"error\":{\"code\":-32601,\"message\":\"unknown method\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":18,\"error\":{\"code\":-32602,\"message\":\"unknown tool no_such_tool\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":19,\"error\":{\"code\":-32602,\"message\":\"limit must be an integer between 1 and 200\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":20,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"unknown evidence id prefix (want cm_/fact_/pref_)\"}],\"isError\":true}}",
    "{\"jsonrpc\":\"2.0\",\"id\":21,\"error\":{\"code\":-32600,\"message\":\"invalid request\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32700,\"message\":\"parse error\"}}"
  ]
}

test('legacy session is byte-identical to the frozen 0.3.2 golden (modern on and off)', async () => {
  for (const options of [{ modern: true }, { modern: false }]) {
    const f = createFixture(options)
    const actual = []
    for (const line of LEGACY_GOLDEN.requests) {
      const response = await f.server.handleLine(line)
      actual.push(response === null ? null : JSON.stringify(response))
    }
    assert.deepEqual(actual, LEGACY_GOLDEN.responses, 'legacy bytes drifted with modern=' + String(options.modern))
  }
})

test('era detection: only modern _meta makes a request modern; initialize stays legacy', async () => {
  const f = createFixture()
  // initialize always answers the legacy handshake, even with stray modern _meta.
  const init = await f.call('initialize', f.modernParams({ protocolVersion: '2024-11-05' }))
  assert.equal(init.result.protocolVersion, PROTOCOL_VERSION)
  assert.equal(Object.hasOwn(init.result, 'resultType'), false)
  // No params at all (or legacy params without modern keys) stays legacy.
  const bare = await f.call('tools/list')
  assert.equal(Object.hasOwn(bare.result, 'resultType'), false)
  for (const meta of [{}, { progressToken: 'p-1' }, { 'io.modelcontextprotocol/unrelated': {} }]) {
    const response = await f.call('tools/list', { _meta: meta })
    assert.equal(Object.hasOwn(response.result, 'resultType'), false, JSON.stringify(meta))
  }
  const modern = await f.call('tools/list', { _meta: MODERN_META })
  assert.equal(modern.result.resultType, 'complete')
  // ping/initialize are legacy-only methods: the modern era rejects them.
  assert.equal((await f.call('ping', f.modernParams())).error.code, -32601)
  assert.equal((await f.call('server/discover', {})).error.code, -32601)
})

test('server/discover advertises 2026-07-28 with capabilities and cache hints', async () => {
  const f = createFixture()
  const response = await f.call('server/discover', f.modernParams())
  assert.equal(response.jsonrpc, '2.0')
  assert.equal(response.id, 1)
  const result = response.result
  assert.equal(result.resultType, 'complete')
  assert.deepEqual(result.supportedVersions, [MODERN_PROTOCOL_VERSION])
  assert.deepEqual([...SUPPORTED_MODERN_PROTOCOL_VERSIONS], ['2026-07-28'])
  assert.equal(result.capabilities.tools.listChanged, false)
  assert.equal(result.capabilities.resources.listChanged, false)
  assert.equal(result.ttlMs, 300000)
  assert.equal(result.cacheScope, 'public')
  assert.deepEqual(result._meta[META_SERVER_INFO], { name: 'advisers', version: SERVER_VERSION })
  assert.equal(Object.hasOwn(result, 'nextCursor'), false)
})

test('every modern success result carries resultType=complete and serverInfo _meta', async () => {
  const f = createFixture()
  const requests = [
    ['server/discover', f.modernParams(), 1],
    ['tools/list', f.modernParams(), 2],
    ['tools/call', f.modernParams({ name: 'advisers_today', arguments: {} }), 3],
    ['resources/list', f.modernParams(), 4],
    ['resources/read', f.modernParams({ uri: 'advisers://today' }), 5],
  ]
  for (const [method, params, id] of requests) {
    const response = await f.call(method, params, id)
    assert.equal(response.result.resultType, 'complete', method)
    assert.deepEqual(response.result._meta[META_SERVER_INFO], { name: 'advisers', version: SERVER_VERSION }, method)
  }
})

test('cache hints: catalogue results public/300000, ledger reads private/0, tools/call none', async () => {
  const f = createFixture()
  const cached = [
    ['server/discover', f.modernParams(), MODERN_CACHE_HINTS.discover],
    ['tools/list', f.modernParams(), MODERN_CACHE_HINTS.toolsList],
    ['resources/list', f.modernParams(), MODERN_CACHE_HINTS.resourcesList],
  ]
  for (const [method, params, expected] of cached) {
    const result = (await f.call(method, params)).result
    assert.equal(result.ttlMs, expected.ttlMs, method)
    assert.equal(result.cacheScope, expected.cacheScope, method)
  }
  const read = (await f.call('resources/read', f.modernParams({ uri: 'advisers://today' }))).result
  assert.equal(read.ttlMs, 0)
  assert.equal(read.cacheScope, 'private')
  const toolCall = (await f.call('tools/call', f.modernParams({ name: 'advisers_today', arguments: {} }))).result
  assert.equal(Object.hasOwn(toolCall, 'ttlMs'), false)
  assert.equal(Object.hasOwn(toolCall, 'cacheScope'), false)
})

test('modern payloads are byte-identical to the legacy payloads', async () => {
  const f = createFixture()
  const toolCalls = [
    ['advisers_today', {}],
    ['advisers_commit_ls', {}],
    ['advisers_commit_ls', { all: true, limit: 2 }],
    ['advisers_who', {}],
    ['advisers_remind', {}],
  ]
  for (const [name, args] of toolCalls) {
    const legacy = await f.call('tools/call', { name, arguments: args })
    const modern = await f.call('tools/call', f.modernParams({ name, arguments: args }))
    assert.equal(modern.result.content[0].text, legacy.result.content[0].text, name + ' content text')
    assert.equal(modern.result.isError, legacy.result.isError, name + ' isError')
  }
  const legacyTools = (await f.call('tools/list')).result.tools
  const modernTools = (await f.call('tools/list', f.modernParams())).result.tools
  assert.equal(JSON.stringify(modernTools), JSON.stringify(legacyTools))
  assert.deepEqual(modernTools.map((tool) => tool.name), [...TOOL_NAMES])
  const legacyResources = (await f.call('resources/list')).result.resources
  const modernResources = (await f.call('resources/list', f.modernParams())).result.resources
  assert.equal(JSON.stringify(modernResources), JSON.stringify(legacyResources))
  assert.deepEqual(modernResources.map((resource) => resource.uri), [...RESOURCE_URIS])
  for (const uri of ['advisers://today', 'advisers://commitments', 'advisers://who']) {
    const legacy = await f.call('resources/read', { uri })
    const modern = await f.call('resources/read', f.modernParams({ uri }))
    assert.equal(modern.result.contents[0].text, legacy.result.contents[0].text, uri)
  }
})

test('clearance filtering and protectedExcluded are identical in both eras', async () => {
  for (const clearance of [0, 2, 3]) {
    const f = createFixture({ clearance })
    for (const [name, args] of [['advisers_today', {}], ['advisers_commit_ls', { all: true }], ['advisers_who', {}], ['advisers_remind', {}]]) {
      const legacy = payloadOf(await f.call('tools/call', { name, arguments: args }))
      const modern = payloadOf(await f.call('tools/call', f.modernParams({ name, arguments: args })))
      assert.deepEqual(modern, legacy, name + ' clearance=' + clearance)
      assert.equal(typeof modern.protectedExcluded, 'number')
    }
  }
})

test('modern _meta validation: missing or ill-typed required fields are -32602', async () => {
  const f = createFixture()
  const invalidMetas = [
    { [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION },
    { [META_CLIENT_CAPABILITIES]: {} },
    { [META_PROTOCOL_VERSION]: 20260728, [META_CLIENT_CAPABILITIES]: {} },
    { [META_PROTOCOL_VERSION]: '', [META_CLIENT_CAPABILITIES]: {} },
    { [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION, [META_CLIENT_CAPABILITIES]: null },
    { [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION, [META_CLIENT_CAPABILITIES]: [] },
    { [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION, [META_CLIENT_CAPABILITIES]: 'all' },
  ]
  for (const meta of invalidMetas) {
    const response = await f.call('tools/list', { _meta: meta })
    assert.equal(response.error?.code, -32602, JSON.stringify(meta))
    assert.equal(Object.hasOwn(response, 'result'), false)
  }
})

test('unsupported modern version is -32022 with the supported list', async () => {
  const f = createFixture()
  for (const requested of ['2025-11-25', '2024-11-05', '1900-01-01']) {
    const response = await f.call('tools/list', { _meta: { [META_PROTOCOL_VERSION]: requested, [META_CLIENT_CAPABILITIES]: {} } })
    assert.equal(response.error.code, -32022, requested)
    assert.equal(response.error.message, 'Unsupported protocol version')
    assert.deepEqual(response.error.data.supported, [MODERN_PROTOCOL_VERSION])
    assert.equal(response.error.data.requested, requested)
  }
})

test('modern error mapping: -32602 for unknown resource, -32601 for legacy-only methods', async () => {
  const f = createFixture()
  const unknown = { uri: 'advisers://does-not-exist' }
  assert.equal((await f.call('resources/read', unknown)).error.code, -32002, 'legacy keeps -32002')
  const modernUnknown = await f.call('resources/read', f.modernParams(unknown))
  assert.equal(modernUnknown.error.code, -32602, 'modern uses -32602')
  assert.equal(Object.hasOwn(modernUnknown, 'result'), false)
  for (const method of ['ping', 'prompts/list', 'logging/setLevel', 'resources/templates/list', 'subscriptions/listen']) {
    assert.equal((await f.call(method, f.modernParams())).error?.code, -32601, method)
  }
  const unknownTool = await f.call('tools/call', f.modernParams({ name: 'no_such_tool', arguments: {} }))
  assert.equal(unknownTool.error.code, -32602)
  const badArgs = await f.call('tools/call', f.modernParams({ name: 'advisers_commit_ls', arguments: { limit: 999 } }))
  assert.equal(badArgs.error.code, -32602)
})

test('modern tool execution failures are complete isError results, not JSON-RPC errors', async () => {
  const f = createFixture()
  const response = await f.call('tools/call', f.modernParams({ name: 'advisers_evidence', arguments: { id: 'zzz' } }))
  assert.equal(Object.hasOwn(response, 'error'), false)
  assert.equal(response.result.resultType, 'complete')
  assert.equal(response.result.isError, true)
  assert.match(response.result.content[0].text, /unknown evidence id prefix/)
})

test('pagination: any client cursor is rejected with -32602', async () => {
  const f = createFixture()
  for (const method of ['tools/list', 'resources/list']) {
    for (const cursor of ['abc', '', null, 0]) {
      const response = await f.call(method, f.modernParams({ cursor }))
      assert.equal(response.error?.code, -32602, method + ' cursor=' + JSON.stringify(cursor))
    }
  }
})

test('modern notifications are ignored (no response) in both eras', async () => {
  const f = createFixture()
  for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/progress']) {
    assert.equal(await f.notify(method), null, method)
    assert.equal(await f.server.handle({ jsonrpc: '2.0', id: 7, method, params: f.modernParams() }), null, method + ' with id')
  }
})

test('modern audit trail is the same as legacy', async () => {
  const f = createFixture()
  await f.call('server/discover', f.modernParams())
  await f.call('tools/list', f.modernParams())
  await f.call('resources/list', f.modernParams())
  assert.deepEqual(f.audits, [], 'catalogue/discover methods must not write audit rows')
  await f.call('tools/call', f.modernParams({ name: 'advisers_today', arguments: {} }))
  await f.call('resources/read', f.modernParams({ uri: 'advisers://today' }))
  assert.deepEqual(f.audits.map((entry) => [entry.actor, entry.action, entry.allowed, entry.reason]), [
    ['mcp', 'mcp.call', true, 'advisers_today'],
    ['mcp', 'mcp.call', true, 'resource:advisers://today'],
  ])
})

test('resolveModernEnabled parses ADVISERS_MCP_MODERN (default on, explicit off values)', () => {
  assert.equal(resolveModernEnabled({}), true)
  for (const value of ['off', 'OFF', ' off ', '0', 'false', 'no', 'disabled']) {
    assert.equal(resolveModernEnabled({ ADVISERS_MCP_MODERN: value }), false, value)
  }
  for (const value of ['on', '1', 'true', 'yes', 'anything-else']) {
    assert.equal(resolveModernEnabled({ ADVISERS_MCP_MODERN: value }), true, value)
  }
})

test('ADVISERS_MCP_MODERN=off forces legacy-only; explicit modern:true overrides the env', async () => {
  const saved = process.env.ADVISERS_MCP_MODERN
  try {
    process.env.ADVISERS_MCP_MODERN = 'off'
    const off = createFixture()
    assert.equal((await off.call('server/discover', off.modernParams())).error.code, -32601)
    const offTools = await off.call('tools/list', off.modernParams())
    assert.equal(Object.hasOwn(offTools.result, 'resultType'), false)
    assert.equal(offTools.result.tools.length, TOOL_NAMES.length)
    const explicit = createFixture({ modern: true })
    assert.equal((await explicit.call('server/discover', explicit.modernParams())).result.resultType, 'complete')
    process.env.ADVISERS_MCP_MODERN = '1'
    const on = createFixture()
    assert.equal((await on.call('server/discover', on.modernParams())).result.resultType, 'complete')
  } finally {
    if (saved === undefined) delete process.env.ADVISERS_MCP_MODERN
    else process.env.ADVISERS_MCP_MODERN = saved
  }
})

test('handleLine serves modern requests from raw stdio lines (one JSON line per response)', async () => {
  const f = createFixture()
  const lineOf = (message) => JSON.stringify({ ...message, params: f.modernParams(message.params ?? {}) })
  const responses = []
  for (const [method, params] of [['server/discover', undefined], ['tools/list', undefined], ['tools/call', { name: 'advisers_today', arguments: {} }]]) {
    const response = await f.server.handleLine(lineOf({ jsonrpc: '2.0', id: method, method, ...(params === undefined ? {} : { params }) }))
    responses.push(JSON.stringify(response))
    assert.equal(response.result.resultType, 'complete')
  }
  assert.equal(responses.length, 3)
  assert.ok(responses.every((line) => !line.includes('\n')))
})
