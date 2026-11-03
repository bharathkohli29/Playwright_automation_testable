import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verdict, analyseJson, analyseXml } from '../utils/s3Check';
import { matchToolRules as matchToolPattern } from '../utils/eksRules';
import { dryTeams, dryRun } from '../utils/dryRun';
import { serviceProblems } from '../utils/eksOnlyRca';
import { warn, warningCount } from '../utils/warn';
import { writeRoundSummary } from '../utils/roundSummary';
import { loadBuilds } from '../utils/builds';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'unit-'));

test('S3 verdict: no files fails, empty files are EMPTY, any data passes', () => {
  assert.equal(verdict([]), 'FAIL');
  assert.equal(verdict([{ empty: true }]), 'EMPTY');
  assert.equal(verdict([{ empty: false }]), 'PASS');
  assert.equal(verdict([{ empty: true }, { empty: false }]), 'PASS');
});

test('S3 JSON analysis: {} and [] are empty, data is not, broken JSON is kept as data', () => {
  assert.equal(analyseJson('{}').empty, true);
  assert.equal(analyseJson('[]').empty, true);
  assert.equal(analyseJson('{"results":[{"a":1}]}').empty, false);
  assert.equal(analyseJson('not json').empty, false);
  assert.equal(analyseXml('<a></a>').empty, true);
});

test('known patterns: workspace permission, CELL_CPU_CAPACITY, OOMKilled, and no match', () => {
  assert.equal(matchToolPattern({ tool: 'x', text: "traversal failed: [Errno 13] Permission denied: '/workspaces/cell-001/a/source/.git/config.lock'" })?.id, 'workspace-permission-denied');
  assert.equal(matchToolPattern({ tool: 'cpd', text: 'WARNING wb-orchestrator: dispatch.admission_rejected_task (tool_name=cpd reason=CELL_CPU_CAPACITY)' })?.id, 'cell-cpu-capacity');
  assert.equal(matchToolPattern({ tool: 'x', text: '', podReason: 'OOMKilled', exitCode: 137 })?.id, 'oom-killed');
  assert.equal(matchToolPattern({ tool: 'x', text: 'everything fine' }), null);
});

test('service lines: rejected / blocked / failed tools are found, INFO lines and other levels are ignored', () => {
  const d = tmp(); const f = path.join(d, 'services.log');
  const line = (o: object) => `[svc] [pod/x] 2026-11-02T09:11:14Z ${JSON.stringify(o)}`;
  fs.writeFileSync(f, [
    line({ level: 'WARNING', message: 'dispatch.admission_rejected_task', tool_name: 'cpd' }),
    line({ level: 'ERROR', message: 'worker.tool_readiness_blocked_execution', tool_name: 'cdxgen' }),
    line({ level: 'WARNING', message: 'handler.failed', tool_name: 'biome' }),
    line({ level: 'INFO', message: 'dispatch.admission_rejected_task', tool_name: 'ignored-info' }),
    'plain text line without json',
  ].join('\n'));
  const m = serviceProblems(f);
  assert.equal(m.get('cpd'), 'NEVER_DISPATCHED');
  assert.equal(m.get('cdxgen'), 'NEVER_DISPATCHED');
  assert.equal(m.get('biome'), 'FAILED');
  assert.equal(m.has('ignored-info'), false);
  assert.equal(serviceProblems(path.join(d, 'missing.log')).size, 0);
});

test('dry run flag and Teams preview: sends nothing and saves the card next to the branch folders', () => {
  const old = process.env.POST_DRYRUN;
  process.env.POST_DRYRUN = '1'; assert.equal(dryRun(), true);
  process.env.POST_DRYRUN = 'off'; assert.equal(dryRun(), false);
  if (old === undefined) delete process.env.POST_DRYRUN; else process.env.POST_DRYRUN = old;
  const round = tmp(); const branch = path.join(round, 'B1'); fs.mkdirSync(branch);
  const card = { attachments: [{ content: { body: [{ type: 'TextBlock', text: '**hello**' }, { type: 'ActionSet', actions: [{ title: 'Open the run' }] }] } }] };
  assert.equal(dryTeams(card, branch), true);
  assert.equal(fs.existsSync(path.join(round, 'dryrun', 'B1-teams-card.json')), true);
  assert.equal(fs.existsSync(path.join(branch, 'teams-card.json')), false);
});

test('warn writes warnings.log and warningCount reads it back', () => {
  const d = tmp();
  assert.equal(warningCount(d), 0);
  warn(d, 'unit-test: one', new Error('boom')); warn(d, 'unit-test: two', 'plain');
  assert.equal(warningCount(d), 2);
  assert.match(fs.readFileSync(path.join(d, 'warnings.log'), 'utf8'), /unit-test: one: boom/);
});

test('round summary: one row per branch folder with its state', () => {
  const round = tmp(); const b = path.join(round, 'JV_X'); fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, 'postprocess.json'), JSON.stringify({ state: 'done', steps: { s3: 'done', teams: 'done' } }));
  fs.writeFileSync(path.join(b, 'run-details.json'), JSON.stringify({ run_id: 'abcdef12-0000' }));
  fs.writeFileSync(path.join(b, 's3-check.json'), JSON.stringify({ java: { version: '17', expected: 20, ok: 4, clean: 0, defects: [{}, {}] } }));
  const file = writeRoundSummary(b)!;
  const md = fs.readFileSync(file, 'utf8');
  assert.match(md, /\| JV_X \| abcdef12 \| Java 17 \| 4\/20 ok \| 2 \| done \| s3 done, teams done \|/);
});

test('builds.json: a whole GitHub link gives repo and branch', () => {
  const d = tmp(); const f = path.join(d, 'builds.json');
  fs.writeFileSync(f, JSON.stringify({ branches: ['https://github.com/owner/repo/tree/feature-1'] }));
  const old = process.env.BUILDS_FILE; process.env.BUILDS_FILE = f;
  try { const b = loadBuilds(); assert.equal(b.length, 1); assert.equal(b[0].repo, 'owner/repo'); assert.equal(b[0].branch, 'feature-1'); }
  finally { if (old === undefined) delete process.env.BUILDS_FILE; else process.env.BUILDS_FILE = old; }
});
