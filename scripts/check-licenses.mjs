#!/usr/bin/env node
/**
 * License gate and third-party notice generator.
 *
 * Verifies:
 *  - all package manifests declare SPDX PolyForm-Noncommercial-1.0.0;
 *  - root and package LICENSE/NOTICE files are byte-identical to the root copies and
 *    carry the PolyForm "Required Notice:" line;
 *  - LICENSE-DOCS (CC BY-NC-SA 4.0), LICENSING.md and the README non-open-source
 *    statements agree with the two-license model;
 *  - the production dependency closure of the six published packages has no disallowed
 *    copyleft license (a dual MIT OR GPL dependency is used under the MIT option);
 *  - THIRD-PARTY-NOTICES.md (root union + one per published package) is up to date.
 *
 * Usage:
 *   node scripts/check-licenses.mjs           # verify (CI)
 *   node scripts/check-licenses.mjs --write   # regenerate THIRD-PARTY-NOTICES.md files
 *
 * THIRD-PARTY-NOTICES.md is generated from "pnpm list --prod --depth 100 --json".
 * Do not edit those files by hand. Development-only dependencies are not listed
 * because they are not distributed with the npm packages.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file) => readFileSync(join(root, file), 'utf8')
const json = (file) => JSON.parse(read(file))
const sha256 = (file) => createHash('sha256').update(readFileSync(join(root, file))).digest('hex')
const readIfExists = (file) => (existsSync(join(root, file)) ? read(file) : '')
const writeMode = process.argv.includes('--write')

const LICENSE_ID = 'PolyForm-Noncommercial-1.0.0'
const DOCS_LICENSE_ID = 'CC-BY-NC-SA-4.0'
const POLYFORM_URL = 'https://polyformproject.org/licenses/noncommercial/1.0.0'
const CC_URL = 'https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.en'
const COMMERCIAL_URL = 'https://github.com/PerryLink/advisers/issues'
const HISTORICAL_APACHE = 'advisers@0.2.0-preview.71'

const APACHE_LICENSE_TEXT = "\n                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n\n   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\n   1. Definitions.\n\n      \"License\" shall mean the terms and conditions for use, reproduction,\n      and distribution as defined by Sections 1 through 9 of this document.\n\n      \"Licensor\" shall mean the copyright owner or entity authorized by\n      the copyright owner that is granting the License.\n\n      \"Legal Entity\" shall mean the union of the acting entity and all\n      other entities that control, are controlled by, or are under common\n      control with that entity. For the purposes of this definition,\n      \"control\" means (i) the power, direct or indirect, to cause the\n      direction or management of such entity, whether by contract or\n      otherwise, or (ii) ownership of fifty percent (50%) or more of the\n      outstanding shares, or (iii) beneficial ownership of such entity.\n\n      \"You\" (or \"Your\") shall mean an individual or Legal Entity\n      exercising permissions granted by this License.\n\n      \"Source\" form shall mean the preferred form for making modifications,\n      including but not limited to software source code, documentation\n      source, and configuration files.\n\n      \"Object\" form shall mean any form resulting from mechanical\n      transformation or translation of a Source form, including but\n      not limited to compiled object code, generated documentation,\n      and conversions to other media types.\n\n      \"Work\" shall mean the work of authorship, whether in Source or\n      Object form, made available under the License, as indicated by a\n      copyright notice that is included in or attached to the work\n      (an example is provided in the Appendix below).\n\n      \"Derivative Works\" shall mean any work, whether in Source or Object\n      form, that is based on (or derived from) the Work and for which the\n      editorial revisions, annotations, elaborations, or other modifications\n      represent, as a whole, an original work of authorship. For the purposes\n      of this License, Derivative Works shall not include works that remain\n      separable from, or merely link (or bind by name) to the interfaces of,\n      the Work and Derivative Works thereof.\n\n      \"Contribution\" shall mean any work of authorship, including\n      the original version of the Work and any modifications or additions\n      to that Work or Derivative Works thereof, that is intentionally\n      submitted to Licensor for inclusion in the Work by the copyright owner\n      or by an individual or Legal Entity authorized to submit on behalf of\n      the copyright owner. For the purposes of this definition, \"submitted\"\n      means any form of electronic, verbal, or written communication sent\n      to the Licensor or its representatives, including but not limited to\n      communication on electronic mailing lists, source code control systems,\n      and issue tracking systems that are managed by, or on behalf of, the\n      Licensor for the purpose of discussing and improving the Work, but\n      excluding communication that is conspicuously marked or otherwise\n      designated in writing by the copyright owner as \"Not a Contribution.\"\n\n      \"Contributor\" shall mean Licensor and any individual or Legal Entity\n      on behalf of whom a Contribution has been received by Licensor and\n      subsequently incorporated within the Work.\n\n   2. Grant of Copyright License. Subject to the terms and conditions of\n      this License, each Contributor hereby grants to You a perpetual,\n      worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n      copyright license to reproduce, prepare Derivative Works of,\n      publicly display, publicly perform, sublicense, and distribute the\n      Work and such Derivative Works in Source or Object form.\n\n   3. Grant of Patent License. Subject to the terms and conditions of\n      this License, each Contributor hereby grants to You a perpetual,\n      worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n      (except as stated in this section) patent license to make, have made,\n      use, offer to sell, sell, import, and otherwise transfer the Work,\n      where such license applies only to those patent claims licensable\n      by such Contributor that are necessarily infringed by their\n      Contribution(s) alone or by combination of their Contribution(s)\n      with the Work to which such Contribution(s) was submitted. If You\n      institute patent litigation against any entity (including a\n      cross-claim or counterclaim in a lawsuit) alleging that the Work\n      or a Contribution incorporated within the Work constitutes direct\n      or contributory patent infringement, then any patent licenses\n      granted to You under this License for that Work shall terminate\n      as of the date such litigation is filed.\n\n   4. Redistribution. You may reproduce and distribute copies of the\n      Work or Derivative Works thereof in any medium, with or without\n      modifications, and in Source or Object form, provided that You\n      meet the following conditions:\n\n      (a) You must give any other recipients of the Work or\n          Derivative Works a copy of this License; and\n\n      (b) You must cause any modified files to carry prominent notices\n          stating that You changed the files; and\n\n      (c) You must retain, in the Source form of any Derivative Works\n          that You distribute, all copyright, patent, trademark, and\n          attribution notices from the Source form of the Work,\n          excluding those notices that do not pertain to any part of\n          the Derivative Works; and\n\n      (d) If the Work includes a \"NOTICE\" text file as part of its\n          distribution, then any Derivative Works that You distribute must\n          include a readable copy of the attribution notices contained\n          within such NOTICE file, excluding those notices that do not\n          pertain to any part of the Derivative Works, in at least one\n          of the following places: within a NOTICE text file distributed\n          as part of the Derivative Works; within the Source form or\n          documentation, if provided along with the Derivative Works; or,\n          within a display generated by the Derivative Works, if and\n          wherever such third-party notices normally appear. The contents\n          of the NOTICE file are for informational purposes only and\n          do not modify the License. You may add Your own attribution\n          notices within Derivative Works that You distribute, alongside\n          or as an addendum to the NOTICE text from the Work, provided\n          that such additional attribution notices cannot be construed\n          as modifying the License.\n\n      You may add Your own copyright statement to Your modifications and\n      may provide additional or different license terms and conditions\n      for use, reproduction, or distribution of Your modifications, or\n      for any such Derivative Works as a whole, provided Your use,\n      reproduction, and distribution of the Work otherwise complies with\n      the conditions stated in this License.\n\n   5. Submission of Contributions. Unless You explicitly state otherwise,\n      any Contribution intentionally submitted for inclusion in the Work\n      by You to the Licensor shall be under the terms and conditions of\n      this License, without any additional terms or conditions.\n      Notwithstanding the above, nothing herein shall supersede or modify\n      the terms of any separate license agreement you may have executed\n      with Licensor regarding such Contributions.\n\n   6. Trademarks. This License does not grant permission to use the trade\n      names, trademarks, service marks, or product names of the Licensor,\n      except as required for reasonable and customary use in describing the\n      origin of the Work and reproducing the content of the NOTICE file.\n\n   7. Disclaimer of Warranty. Unless required by applicable law or\n      agreed to in writing, Licensor provides the Work (and each\n      Contributor provides its Contributions) on an \"AS IS\" BASIS,\n      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or\n      implied, including, without limitation, any warranties or conditions\n      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A\n      PARTICULAR PURPOSE. You are solely responsible for determining the\n      appropriateness of using or redistributing the Work and assume any\n      risks associated with Your exercise of permissions under this License.\n\n   8. Limitation of Liability. In no event and under no legal theory,\n      whether in tort (including negligence), contract, or otherwise,\n      unless required by applicable law (such as deliberate and grossly\n      negligent acts) or agreed to in writing, shall any Contributor be\n      liable to You for damages, including any direct, indirect, special,\n      incidental, or consequential damages of any character arising as a\n      result of this License or out of the use or inability to use the\n      Work (including but not limited to damages for loss of goodwill,\n      work stoppage, computer failure or malfunction, or any and all\n      other commercial damages or losses), even if such Contributor\n      has been advised of the possibility of such damages.\n\n   9. Accepting Warranty or Additional Liability. While redistributing\n      the Work or Derivative Works thereof, You may choose to offer,\n      and charge a fee for, acceptance of support, warranty, indemnity,\n      or other liability obligations and/or rights consistent with this\n      License. However, in accepting such obligations, You may act only\n      on Your own behalf and on Your sole responsibility, not on behalf\n      of any other Contributor, and only if You agree to indemnify,\n      defend, and hold each Contributor harmless for any liability\n      incurred by, or claims asserted against, such Contributor by reason\n      of your accepting any such warranty or additional liability.\n\n   END OF TERMS AND CONDITIONS\n\n   APPENDIX: How to apply the Apache License to your work.\n\n      To apply the Apache License to your work, attach the following\n      boilerplate notice, with the fields enclosed by brackets \"[]\"\n      replaced with your own identifying information. (Don't include\n      the brackets!)  The text should be enclosed in the appropriate\n      comment syntax for the file format. We also recommend that a\n      file or class name and description of purpose be included on the\n      same \"printed page\" as the copyright notice for easier\n      identification within third-party archives.\n\n   Copyright [yyyy] [name of copyright owner]\n\n   Licensed under the Apache License, Version 2.0 (the \"License\");\n   you may not use this file except in compliance with the License.\n   You may obtain a copy of the License at\n\n       http://www.apache.org/licenses/LICENSE-2.0\n\n   Unless required by applicable law or agreed to in writing, software\n   distributed under the License is distributed on an \"AS IS\" BASIS,\n   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.\n   See the License for the specific language governing permissions and\n   limitations under the License.\n"

const PACKAGES = [
  { dir: 'packages/core', name: 'advisers-core', published: true },
  { dir: 'packages/office', name: 'advisers-office', published: true },
  { dir: 'packages/policy-strict', name: 'advisers-policy-strict', published: true },
  { dir: 'packages/bridge-hermes', name: 'advisers-bridge-hermes', published: true },
  { dir: 'packages/advisers', name: 'advisers', published: true },
  { dir: 'packages/dsh-advisers', name: 'dsh-advisers', published: true },
  { dir: 'packages/link-email', name: 'advisers-link-email', published: false },
  { dir: 'packages/link-feishu', name: 'advisers-link-feishu', published: false },
]
const PUBLISHED = PACKAGES.filter((meta) => meta.published)
const REQUIRED_TARBALL_FILES = ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']
const README_LICENSE_FILES = [
  'README.md',
  'README-zh.md',
  ...PUBLISHED.map((meta) => meta.dir + '/README.md'),
  'packages/advisers/README-zh.md',
  'packages/link-feishu/README.md',
]
const NOT_OPEN_SOURCE_CLAIMS = [
  ['README.md', /not open source/i],
  ['README-zh.md', /不是开源|非开源/],
]

// A dual MIT OR GPL dependency is acceptable because Advisers uses the MIT option.
const COPYLEFT_RE = /(?:AGPL-[0-9]|GPL-[0-9]|LGPL-[0-9]|SSPL-[0-9]|BUSL-[0-9]|Business Source|Elastic License|Commons Clause)/i
const NO_LICENSE_WHITELIST = {
  'buffers@0.1.1':
    'upstream chain exceljs -> unzipper -> binary publishes no license field; no permission is granted by that package, so do not extract or redistribute it; replacing it is a P2 follow-up',
}
// Optional platform binaries are installed only on a matching OS/CPU. The others are
// absent on every platform, so skipping them keeps the generated notices stable.
const OPTIONAL_PLATFORM_RE = /^@napi-rs\/canvas-(?:android|darwin|linux|win32)-/

const failures = []
const warnings = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(name + (detail ? ': ' + detail : ''))
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? ' - ' + detail : ''))
}
const warn = (message) => {
  warnings.push(message)
  console.log('WARN ' + message)
}

// ---------------------------------------------------------------------------
// 1. package manifests
// ---------------------------------------------------------------------------
for (const meta of PACKAGES) {
  const pkg = json(meta.dir + '/package.json')
  check(meta.dir + ' license field', pkg.license === LICENSE_ID, 'found ' + String(pkg.license))
  if (!meta.published) continue
  for (const file of REQUIRED_TARBALL_FILES) {
    check(
      meta.dir + ' files allowlist includes ' + file,
      Array.isArray(pkg.files) && pkg.files.includes(file),
      'files=' + JSON.stringify(pkg.files),
    )
  }
}

// ---------------------------------------------------------------------------
// 2. root license files and policy
// ---------------------------------------------------------------------------
const licenseText = read('LICENSE')
check('LICENSE contains PolyForm Noncommercial License 1.0.0', licenseText.includes('PolyForm Noncommercial License 1.0.0'))
check('LICENSE contains the official PolyForm URL', licenseText.includes(POLYFORM_URL))
check('LICENSE contains the Required Notice clause', licenseText.includes('Required Notice:'))
check('LICENSE no longer contains the Apache License text', !licenseText.includes('Apache License'))

const noticeText = read('NOTICE')
check('NOTICE contains Required Notice:', noticeText.includes('Required Notice:'))
check('NOTICE names PolyForm', noticeText.includes('PolyForm'))
check('NOTICE names CC BY-NC-SA 4.0', noticeText.includes('CC BY-NC-SA 4.0'))
check('NOTICE says not open source', /not open source/i.test(noticeText))
check('NOTICE documents the non-retroactive history', /not retroactive/i.test(noticeText) && noticeText.includes(HISTORICAL_APACHE))

const docsLicenseText = readIfExists('LICENSE-DOCS')
check('LICENSE-DOCS contains the CC BY-NC-SA 4.0 title', docsLicenseText.includes('Attribution-NonCommercial-ShareAlike 4.0 International'))
check('LICENSE-DOCS contains the canonical legal code URL', docsLicenseText.includes(CC_URL))

const licensingText = readIfExists('LICENSING.md')
check('LICENSING.md contains the software SPDX id', licensingText.includes(LICENSE_ID))
check('LICENSING.md contains the docs SPDX id', licensingText.includes(DOCS_LICENSE_ID))
check('LICENSING.md says not open source', /not open source/i.test(licensingText))
check('LICENSING.md says 非开源', licensingText.includes('非开源'))
check(
  'LICENSING.md records the current LICENSE/NOTICE sha256',
  licensingText.includes(sha256('LICENSE')) && licensingText.includes(sha256('NOTICE')),
  'update the hash table in LICENSING.md after changing LICENSE or NOTICE',
)
check('LICENSING.md points at the commercial-license channel', licensingText.includes(COMMERCIAL_URL))

// ---------------------------------------------------------------------------
// 3. package LICENSE/NOTICE copies must be byte-identical to the root files
// ---------------------------------------------------------------------------
const rootHashes = { LICENSE: sha256('LICENSE'), NOTICE: sha256('NOTICE') }
for (const meta of PACKAGES) {
  for (const file of ['LICENSE', 'NOTICE']) {
    const local = meta.dir + '/' + file
    if (!existsSync(join(root, local))) {
      if (meta.published) failures.push(local + ': missing')
      continue
    }
    check(local + ' matches root ' + file, sha256(local) === rootHashes[file])
  }
}

// ---------------------------------------------------------------------------
// 4. docs must show the two-license model and must not call the project open source
// ---------------------------------------------------------------------------
for (const file of README_LICENSE_FILES) {
  check(file + ' license section mentions PolyForm', /PolyForm/.test(read(file)))
}
for (const [file, re] of NOT_OPEN_SOURCE_CLAIMS) {
  check(file + ' says the project is not open source', re.test(read(file)))
}

// ---------------------------------------------------------------------------
// 5. dependency audit (production closure of the six published packages)
// ---------------------------------------------------------------------------
function listProjects() {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const raw = execFileSync(pnpm, ['list', '--prod', '--depth', '100', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 512 * 1024 * 1024,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(raw)
}

function collectClosure(project, workspaceNames) {
  const seen = new Map()
  const visit = (dependencies) => {
    for (const [name, info] of Object.entries(dependencies || {})) {
      if (!info || typeof info.version !== 'string' || info.version.startsWith('link:')) continue
      if (workspaceNames.has(name)) continue
      const key = name + '@' + info.version
      if (seen.has(key)) continue
      seen.set(key, { name, version: info.version, path: info.path })
      visit(info.dependencies)
    }
  }
  visit(project.dependencies)
  return [...seen.values()]
}

const deps = new Map()
let dependencyDataOk = true
try {
  const projects = listProjects()
  const byName = new Map(projects.map((project) => [project.name, project]))
  const workspaceNames = new Set(projects.map((project) => project.name))
  for (const meta of PUBLISHED) {
    const project = byName.get(meta.name)
    if (!project) {
      failures.push('dependency audit: workspace project ' + meta.name + ' not found in pnpm list')
      dependencyDataOk = false
      continue
    }
    const closure = collectClosure(project, workspaceNames)
    check(meta.name + ' production closure resolved', true)
    for (const dep of closure) {
      const key = dep.name + '@' + dep.version
      if (!deps.has(key)) deps.set(key, { ...dep, consumers: new Set() })
      deps.get(key).consumers.add(meta.name)
    }
  }
} catch (error) {
  dependencyDataOk = false
  failures.push('dependency audit could not run pnpm list: ' + String(error.message || error).slice(0, 300))
}

let optionalPlatformCount = 0
let copyleftFailures = 0
for (const key of [...deps.keys()].sort()) {
  const dep = deps.get(key)
  let pkg = null
  try {
    pkg = JSON.parse(readFileSync(join(dep.path, 'package.json'), 'utf8'))
  } catch {
    if (OPTIONAL_PLATFORM_RE.test(dep.name)) {
      dep.optionalPlatform = true
      optionalPlatformCount += 1
      continue
    }
    failures.push('dependency ' + key + ': package.json not found at ' + dep.path + ' (run pnpm install)')
    dependencyDataOk = false
    continue
  }
  let license = pkg.license
  if (typeof license !== 'string' && Array.isArray(pkg.licenses)) license = pkg.licenses.map((entry) => entry.type || entry).join(' OR ')
  dep.license = typeof license === 'string' && license.trim() ? license.trim() : ''
  if (!dep.license) {
    if (NO_LICENSE_WHITELIST[key]) {
      dep.noLicense = true
      warn(key + ' has no license field (whitelisted): ' + NO_LICENSE_WHITELIST[key])
    } else {
      copyleftFailures += 1
      failures.push('dependency ' + key + ' has no license field and is not whitelisted')
    }
    continue
  }
  if (COPYLEFT_RE.test(dep.license)) {
    if (/\bMIT\b/.test(dep.license) && /\bOR\b/.test(dep.license)) {
      warn('dependency ' + key + ' is dual-licensed (' + dep.license + '); Advisers uses the MIT option')
    } else {
      copyleftFailures += 1
      failures.push('dependency ' + key + ' uses disallowed copyleft license: ' + dep.license)
    }
  }
}
const licenseCounts = {}
for (const dep of deps.values()) {
  if (dep.optionalPlatform) continue
  const key = dep.license || 'no license declared'
  licenseCounts[key] = (licenseCounts[key] || 0) + 1
}
const licenseSummary = Object.keys(licenseCounts).sort().map((key) => key + ' x' + licenseCounts[key]).join(', ')
check('dependency audit found no disallowed copyleft license', copyleftFailures === 0, licenseSummary)
console.log('INFO production dependency audit: ' + [...deps.values()].filter((dep) => !dep.optionalPlatform).length + ' unique third-party packages (' + licenseSummary + ')')
if (optionalPlatformCount) console.log('INFO skipped ' + optionalPlatformCount + ' optional platform binaries not installed on this platform')

// ---------------------------------------------------------------------------
// 6. THIRD-PARTY-NOTICES.md (generated; root union + one file per package)
// ---------------------------------------------------------------------------
const GROUP_ORDER = ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', 'MIT OR GPL-3.0-or-later', 'MIT AND Zlib', '0BSD', 'Unlicense', 'MIT/X11']
const DISPLAY_LICENSE = (raw) => {
  const wrapped = /^\(([^()]*)\)$/.exec(raw)
  return wrapped ? wrapped[1] : raw
}

function renderNotices(options) {
  const title = options.title
  const selectedDeps = options.selectedDeps
  const scopeLine = options.scopeLine
  const lines = []
  lines.push('# ' + title)
  lines.push('')
  lines.push('Advisers software is licensed under the PolyForm Noncommercial License 1.0.0')
  lines.push('(SPDX: PolyForm-Noncommercial-1.0.0); see LICENSE and NOTICE. Documentation,')
  lines.push('evaluation data and design materials are licensed under CC BY-NC-SA 4.0 (see')
  lines.push('LICENSE-DOCS). This file covers third-party components only: they keep their own')
  lines.push('licenses and are not relicensed by Advisers.')
  lines.push('')
  lines.push('Generated by "node scripts/check-licenses.mjs --write" from the production')
  lines.push('dependency closure of the published packages ("pnpm list --prod --depth 100";')
  lines.push('devDependencies and workspace packages excluded). Do not edit by hand; CI runs')
  lines.push('"node scripts/check-licenses.mjs".')
  lines.push('')
  lines.push(scopeLine)
  lines.push('')
  if (selectedDeps.length === 0) {
    lines.push('No third-party production dependencies were found for this scope.')
    lines.push('')
    return lines.join('\n')
  }
  if (optionalPlatformCount) {
    lines.push('Optional platform-specific binaries (for example the @napi-rs/canvas builds for')
    lines.push('other operating systems and CPU architectures) are installed only on a matching')
    lines.push('platform. ' + optionalPlatformCount + ' such packages are declared but not installed here and')
    lines.push('are omitted; the installed platform binary is listed below where applicable.')
    lines.push('')
  }
  const groups = new Map()
  for (const dep of selectedDeps) {
    const key = dep.noLicense ? 'no license declared' : DISPLAY_LICENSE(dep.license)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(dep.name + '@' + dep.version)
  }
  for (const list of groups.values()) list.sort()
  const ordered = [...groups.keys()].sort((a, b) => {
    if (a === 'no license declared') return 1
    if (b === 'no license declared') return -1
    const orderA = GROUP_ORDER.indexOf(a)
    const orderB = GROUP_ORDER.indexOf(b)
    if (orderA !== -1 || orderB !== -1) return (orderA === -1 ? 99 : orderA) - (orderB === -1 ? 99 : orderB)
    return a.localeCompare(b)
  })
  lines.push('## Summary')
  lines.push('')
  lines.push('| License | Packages |')
  lines.push('| --- | ---: |')
  for (const key of ordered) lines.push('| ' + key + ' | ' + groups.get(key).length + ' |')
  lines.push('')
  for (const key of ordered) {
    lines.push('## ' + key + ' (' + groups.get(key).length + ')')
    lines.push('')
    if (key === 'no license declared') {
      for (const entry of groups.get(key)) lines.push('- ' + entry + ': ' + (NO_LICENSE_WHITELIST[entry] || 'no license declaration found'))
    } else {
      for (const entry of groups.get(key)) lines.push('- ' + entry)
    }
    lines.push('')
    if (key === 'MIT OR GPL-3.0-or-later') {
      lines.push('These packages are dual-licensed MIT OR GPL-3.0-or-later. Advisers uses them')
      lines.push('under the MIT option; the GPL option is not used.')
      lines.push('')
    }
    if (key === 'Apache-2.0') {
      lines.push('### Apache License 2.0 (full text)')
      lines.push('')
      for (const line of APACHE_LICENSE_TEXT.replace(/\s+$/, '').split('\n')) lines.push(line)
      lines.push('')
    }
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n'
}

const rootDeps = [...deps.values()].filter((dep) => !dep.optionalPlatform)
const generated = []
if (dependencyDataOk) {
  generated.push({
    file: 'THIRD-PARTY-NOTICES.md',
    content: renderNotices({
      title: 'Third-Party Notices',
      selectedDeps: rootDeps,
      scopeLine:
        'This file covers the union of the third-party production dependencies of the six published packages: ' +
        PUBLISHED.map((meta) => meta.name).join(', ') + '.',
    }),
  })
  for (const meta of PUBLISHED) {
    const version = json(meta.dir + '/package.json').version
    generated.push({
      file: meta.dir + '/THIRD-PARTY-NOTICES.md',
      content: renderNotices({
        title: 'Third-Party Notices - ' + meta.name,
        selectedDeps: rootDeps.filter((dep) => dep.consumers.has(meta.name)),
        scopeLine:
          'This file is shipped with the ' + meta.name + '@' + version + ' npm package and covers the third-party ' +
          'production dependencies of that package only. Each dependency keeps its own license.',
      }),
    })
  }
} else {
  console.log('SKIP THIRD-PARTY-NOTICES.md rendering: dependency closure unavailable')
}

for (const item of generated) {
  if (writeMode) {
    writeFileSync(join(root, item.file), item.content)
    console.log('WROTE ' + item.file)
  } else if (!existsSync(join(root, item.file))) {
    failures.push(item.file + ': missing (run node scripts/check-licenses.mjs --write)')
    console.log('FAIL ' + item.file + ' missing')
  } else if (read(item.file) !== item.content) {
    failures.push(item.file + ': stale (run node scripts/check-licenses.mjs --write)')
    console.log('FAIL ' + item.file + ' stale')
  } else {
    console.log('PASS ' + item.file + ' up to date')
  }
}

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------
if (failures.length) {
  console.error('')
  console.error(failures.length + ' license inconsistency(ies):')
  for (const failure of failures) console.error('- ' + failure)
  process.exit(1)
}
console.log('')
console.log('PASS license policy (' + LICENSE_ID + ' + ' + DOCS_LICENSE_ID + ', ' + rootDeps.length + ' third-party packages)')
