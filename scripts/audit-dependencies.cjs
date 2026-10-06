// npm's version-based audit cannot detect our tested backports. Reject any new advisory.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const result = spawnSync(process.execPath, [npmCli, 'audit', '--omit=dev', '--json'], { encoding: 'utf8' });
if (result.error || result.status > 1) throw result.error || new Error(result.stderr || 'npm audit failed');
const report = JSON.parse(result.stdout);
if (report.error) throw new Error(report.error.summary || 'npm audit failed');
const mitigated = new Set(['GHSA-vfj7-8cjw-p6xm', 'GHSA-86w9-cpqp-85rv']);
const unresolved = new Set();
for (const entry of Object.values(report.vulnerabilities || {})) {
  for (const advisory of entry.via || []) {
    if (typeof advisory !== 'object') continue;
    const id = advisory.url?.split('/').pop();
    if (!mitigated.has(id)) unresolved.add(`${advisory.name}: ${advisory.title} (${advisory.url})`);
  }
}
if (unresolved.size) {
  console.error([...unresolved].join('\n'));
  process.exitCode = 1;
} else {
  console.log(`No unmitigated advisories. Version-based npm audit still flags ${report.metadata?.vulnerabilities?.total || 0} dependency entries for the two tested upstream backports.`);
}
