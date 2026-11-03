import * as fs from 'fs';
import * as path from 'path';
import { warn } from './warn';
import { execFile, spawn, ChildProcess } from 'child_process';
import { eksAutoEnabled, eksEnv } from './eksAnalyze';
import { matchRunPattern, RunPattern } from './eksPatterns';
import { buildRunReport } from './eksReport';

/**
 * LIVE QA EKS collector. Started by the flow the moment the run is executing (step 11) and stopped when the run is finished (step 12).
 * Why: the tool pods (wb-exec-*) disappear about 60 s after they finish and the S3 bucket keeps only result files, so a pod's console log
 * can only be saved while the run is going on.
 *
 * READ-ONLY. It runs only:  kubectl get / logs / describe  (never exec, delete, edit, scale, apply, port-forward, secrets).
 * Never throws, never slows the test: start() returns at once, everything runs in the background, and when the cluster is not reachable it
 * writes one line saying so. On when EKS_AUTO=on (or the EKS key is in .env); EKS_LIVE=off switches only this part off.
 *
 * Writes <branch folder>/eks-live/
 *   summary.json           what was captured, gaps, stuck-run flag
 *   tools.json             one record per tool pod: tool, pod, node, phase, exit code, reason (OOMKilled ...), times (IST), console file
 *   pods/<pod>/{console.log, pod.json, describe.txt}
 *   services.log           only the lines of the cell services that mention THIS run or its tasks
 *   snapshots.jsonl        runtime-* replicas every 30 s
 * and the unfiltered service logs (other runs / other people's lines included) stay OUTSIDE the branch folder, so SharePoint never gets them:
 *   results/.eks-raw/<run id>/<service>.log
 * Every line is redacted first (Bearer tokens, ghp_ / github_pat_ / AKIA keys, passwords, private keys, DATABASE_URL-style strings).
 */
const CTX = 'qa-eks-ro';
const clean = (s?: string) => (s || '').trim().replace(/^["']|["']$/g, '');
const KUBECTL = () => clean(process.env.EKS_KUBECTL) || 'kubectl';
const WIN = process.platform === 'win32';
const SERVICE_RE = /(orchestrator|execution-control|runtime-api|cpu-worker|io-worker|scoring-worker|reconciliation-worker|runtime-reconciler|admission|control-plane)/i;

export function redact(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]{8,}/gi, '$1[redacted]')
    .replace(/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g, '[redacted-github-token]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted-github-token]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted-aws-key]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----.*/g, '[redacted-private-key]')
    .replace(/^[A-Za-z0-9+\/=]{60,}$/gm, '[redacted-key-material]')
    .replace(/\b((?:[A-Z0-9_]*)(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY)(?:[A-Z0-9_]*))(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2[redacted]')
    .replace(/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)s?:\/\/[^\s"']+/gi, '$1://[redacted]')
    .replace(/\bDATABASE_URL\b\s*[:=]\s*\S+/gi, 'DATABASE_URL=[redacted]');
}

/** JSON stays valid JSON: every string is redacted, and the value of an env var whose NAME looks secret is replaced */
export function redactJson(o: unknown): string {
  const walk = (v: any): any => {
    if (typeof v === 'string') return redact(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: any = {}; const isEnv = typeof v.name === 'string' && 'value' in v;
      for (const [k, x] of Object.entries(v)) out[k] = isEnv && k === 'value' && /PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|CREDENTIAL|DATABASE_URL/i.test(v.name) ? '[redacted]' : walk(x);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(o), null, 2);
}

const ist = (d: Date | string | number) => { try { return new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '') + ' IST'; } catch { return String(d); } };
const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 80);
const TS_RE = /(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/;

function kc(args: string[], timeout = 20_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    try {
      execFile(KUBECTL(), ['--context', CTX, ...args], { env: eksEnv(), timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024, shell: WIN }, (err, so, se) =>
        resolve({ code: err ? Number((err as { code?: number }).code) || 1 : 0, out: `${so || ''}${err ? se || '' : ''}` }));
    } catch (e) { resolve({ code: 127, out: String(e) }); }
  });
}

export interface PodRecord {
  tool: string; toolFrom: 'label' | 'pod name' | 'orchestrator log (task id)'; task?: string; image?: string; command?: string; pod: string; namespace: string; node?: string; phase?: string; exitCode?: number | null; reason?: string; message?: string;
  restarts?: number; started?: string; finished?: string; seenFirst: string; seenLast: string; gone: boolean; consoleFile: string; consoleLines: number; gaps: string[]; otherRun?: boolean;
}
export interface EksCollector {
  stop(): Promise<void>; enabled: boolean;
  /** text when the run is stuck for good (RUNTIME_UNAVAILABLE loop with no progress), else null. Lets the flow stop waiting early. */
  stuck(): string | null;
  /** the run-level finding (known pattern) once stop() has run, else null */
  diagnosis(): RunPattern | null;
}

/** tool name from the pod's labels, else from the pod name (wb-exec-<tool>-<hash>-<suffix>) */
export function toolOfPod(pod: any): { tool: string; from: 'label' | 'pod name' | 'orchestrator log (task id)' } {
  const labels: Record<string, string> = { ...(pod?.metadata?.labels || {}), ...(pod?.metadata?.annotations || {}) };
  for (const [k, v] of Object.entries(labels)) if (/(^|[./_-])tool([_-]?name)?$/i.test(k) && v && v.length < 60) return { tool: v, from: 'label' };
  const raw = String(pod?.metadata?.name || '').replace(/^wb-exec-/, '');
  if (/^[a-f0-9]{20,}/.test(raw)) return { tool: '', from: 'pod name' }; // job pods are named after a hash, not the tool: the tool comes from the task id (orchestrator log)
  const parts = raw.split('-');
  let dropped = 0;
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (/^[a-f0-9]{6,}$/.test(last) || /^\d+$/.test(last) || (dropped > 0 && /^[a-z0-9]{4,6}$/.test(last))) { parts.pop(); dropped++; } else break;
  }
  return { tool: parts.join('-') || String(pod?.metadata?.name || 'unknown'), from: 'pod name' };
}

/** does this pod belong to our run? yes when it mentions our run id; unknown (no run id at all) counts as ours; another run id = not ours */
export function podBelongs(podJson: string, runId: string): boolean {
  if (!runId || podJson.includes(runId)) return true;
  const other = /run[-_]?id["'=:\s]+["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(podJson);
  return !(other && other[1].toLowerCase() !== runId.toLowerCase());
}

export function startEksCollector(opts: { branchDir: string; runId: string; branch?: string }): EksCollector {
  const off: EksCollector = { stop: async () => {}, enabled: false, stuck: () => null, diagnosis: () => null };
  try {
    if (!eksAutoEnabled() || /^(off|no|0|false)$/i.test(clean(process.env.EKS_LIVE)) || !opts.runId) return off;
    const dir = path.join(opts.branchDir, 'eks-live');
    const rawDir = path.join(opts.branchDir, '..', '..', '.eks-raw', opts.runId);
    fs.mkdirSync(path.join(dir, 'pods'), { recursive: true }); fs.mkdirSync(rawDir, { recursive: true });
    const say = (m: string) => console.log(`  QA EKS live: ${m}`);
    const started = Date.now();
    let stopped = false;
    const timers: NodeJS.Timeout[] = []; const children = new Set<ChildProcess>();
    const gaps: string[] = []; const notes: string[] = [];
    const pods = new Map<string, PodRecord>(); const followed = new Set<string>();
    const taskIds = new Set<string>(); const runtimesWaiting = new Set<string>(); const reasons = new Set<string>();
    const planned = new Map<string, { tool?: string; runtime?: string; last?: string }>(); const scaledZero = new Set<string>();
    let waitFirst = ''; let waitLast = ''; let waitSample = ''; let lastProgress = Date.now(); let finding: RunPattern | null = null;
    let waitRepeats = 0; let netErrors = 0; let ctxOk = false; let nsInfo = { cell: [] as string[], exe: [] as string[], global: [] as string[] };
    const servicesLog = fs.createWriteStream(path.join(dir, 'services.log'), { flags: 'a' });
    const snapshotsLog = fs.createWriteStream(path.join(dir, 'snapshots.jsonl'), { flags: 'a' });
    const raws = new Map<string, fs.WriteStream>();
    const rawFor = (svc: string) => { let w = raws.get(svc); if (!w) { w = fs.createWriteStream(path.join(rawDir, `${safeName(svc)}.log`), { flags: 'a' }); raws.set(svc, w); } return w; };
    const short = opts.runId.split('-')[0];

    /** follow one pod's logs (all containers); reconnect from the last timestamp when the stream breaks */
    const follow = (ns: string, pod: string, onLine: (line: string) => void, label: string, onEnd?: () => Promise<void>) => {
      const key = `${ns}/${pod}`; if (followed.has(key)) return; followed.add(key);
      let last = ''; let tries = 0; const recent: string[] = []; const seen = new Set<string>(); // the line at the --since-time boundary comes twice: drop repeats of the last 300 lines
      const go = () => {
        if (stopped) return;
        const connectedAt = Date.now();
        const args = ['--context', CTX, 'logs', '-f', '--timestamps', '--all-containers=true', '--prefix=true', '--max-log-requests=10', '-n', ns, pod];
        if (last) args.push(`--since-time=${last}`);
        const child = spawn(KUBECTL(), args, { env: eksEnv(), windowsHide: true, shell: WIN });
        children.add(child); let buf = '';
        const feed = (d: Buffer) => { buf += d.toString('utf8'); let i: number; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); const m = TS_RE.exec(line); if (m) last = m[1]; const dk = line.replace(/^\[[^\]]*\]\s*/, ''); if (seen.has(dk)) continue; seen.add(dk); recent.push(dk); if (recent.length > 300) seen.delete(recent.shift()!); try { onLine(line); } catch { /* ignore */ } } };
        child.stdout?.on('data', feed); child.stderr?.on('data', feed);
        child.on('error', () => { children.delete(child); });
        child.on('close', async () => {
          children.delete(child); if (buf) { try { onLine(buf); } catch (e) { warn(opts.branchDir, 'collector: last log line', e); } }
          if (onEnd) { try { await onEnd(); } catch (e) { warn(opts.branchDir, 'collector: final pod state', e); } } // tool pods: read the final state right now, before the pod is deleted
          const rec = pods.get(key);
          if (Date.now() - connectedAt > 60_000) tries = 0; // a stream that lived a minute counts as healthy
          if (!stopped && tries < 6 && !(rec && rec.gone) && !(rec && /Succeeded|Failed/.test(rec.phase || ''))) { tries++; if (last && gaps.length < 30) gaps.push(`${label}: log stream ended, reconnected from ${last}`); setTimeout(go, 2000); }
        });
      };
      go();
    };

    // ----- cell services: lines of this run (and its tasks) go to services.log; everything unfiltered goes to .eks-raw (not uploaded)
    const watchService = (ns: string, podName: string) => {
      const svc = podName.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, '').replace(/-[a-z0-9]{5}$/, '');
      follow(ns, podName, (line) => {
        const red = redact(line); rawFor(svc).write(red + '\n');
        const m = /task[_-]?id["'=:\s]+["']?([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(line);
        const mine = line.includes(opts.runId) || line.includes(short);
        if (mine && m) {
          taskIds.add(m[1].toLowerCase());
          const tn = /["']?tool(?:_name)?["']?\s*[:=]\s*["']?([A-Za-z0-9_.-]{2,40})/i.exec(line); const rn = /["']?runtime(?:_id|_family)?["']?\s*[:=]\s*["']?(worker-[a-z0-9-]+|[a-z0-9_-]{3,30})/i.exec(line);
          const cur = planned.get(m[1].toLowerCase()) || {}; planned.set(m[1].toLowerCase(), { tool: cur.tool || (tn ? tn[1] : undefined), runtime: cur.runtime || (rn ? rn[1] : undefined), last: red.replace(/^\[[^\]]*\]\s*/, '').slice(0, 240) });
        }
        const tid = !mine ? [...taskIds].find((t) => line.toLowerCase().includes(t)) : undefined; const task = !!tid;
        if (tid) { const cur = planned.get(tid) || {}; planned.set(tid, { ...cur, last: red.replace(/^\[[^\]]*\]\s*/, '').slice(0, 240) }); }
        if (mine || task) {
          servicesLog.write(`[${svc}] ${red}\n`);
          if (/RUNTIME_UNAVAILABLE/.test(line)) {
            waitRepeats++; const ts = TS_RE.exec(line)?.[1] || ''; if (!waitFirst) { waitFirst = ts; waitSample = red.replace(/^\[[^\]]*\]\s*/, '').slice(0, 260); } waitLast = ts || waitLast;
            for (const r of line.match(/worker-[a-z0-9]+(?:-[a-z0-9]+)*/gi) || []) runtimesWaiting.add(r);
            const r2 = /runtime["'=:\s]+["']?([a-z0-9_-]{2,30})/i.exec(line); if (r2) runtimesWaiting.add(r2[1]);
            if (/ANALYZER_JOBS_REPLACE_FAMILY_WORKERS/i.test(line)) reasons.add('ANALYZER_JOBS_REPLACE_FAMILY_WORKERS');
          } else if (!/\bGET \/v1\/runs\b|metric\.(counter|histogram)/.test(line)) lastProgress = Date.now();
        }
      }, svc);
    };

    // ----- tool pods in the -exe namespace
    const readPods = async (ns: string) => {
      const r = await kc(['get', 'pods', '-n', ns, '-o', 'json', '--request-timeout=10s'], 25_000);
      if (r.code !== 0) { if (!/NotFound|not found/i.test(r.out)) { const n = `could not list pods in ${ns}: ${r.out.trim().split('\n').pop()?.slice(0, 120)}`; netErrors++; if (netErrors <= 3 && !notes.includes(n)) notes.push(n); } return null; }
      try { return (JSON.parse(r.out).items || []) as any[]; } catch { return null; }
    };
    const updateRec = (rec: PodRecord, pod: any) => {
      const st = pod.status || {}; rec.phase = st.phase; rec.node = pod.spec?.nodeName || rec.node; rec.seenLast = new Date().toISOString();
      const cs = [...(st.initContainerStatuses || []), ...(st.containerStatuses || [])];
      let restarts = 0;
      for (const c of cs) {
        restarts += c.restartCount || 0;
        const t = c.state?.terminated || c.lastState?.terminated;
        if (t) { if (rec.exitCode == null || (t.exitCode && !rec.exitCode)) { rec.exitCode = t.exitCode; rec.reason = t.reason || rec.reason; rec.message = (t.message || '').slice(0, 300) || rec.message; } rec.started = t.startedAt || rec.started; rec.finished = t.finishedAt || rec.finished; }
        const w = c.state?.waiting; if (w && /ImagePull|ErrImage|CrashLoop|CreateContainer/.test(w.reason || '')) { rec.reason = w.reason; rec.message = (w.message || '').slice(0, 300); }
      }
      rec.restarts = restarts;
      if (st.reason && !rec.reason) rec.reason = st.reason; // Evicted ...
    };
    const resolveTools = () => {
      for (const rec of pods.values()) {
        const fromTask = rec.task ? planned.get(rec.task.toLowerCase())?.tool : undefined;
        if (fromTask && rec.toolFrom !== 'label') { rec.tool = fromTask; rec.toolFrom = 'orchestrator log (task id)'; }
        if (!rec.tool) rec.tool = `task-${(rec.task || rec.pod).replace(/^wb-exec-/, '').slice(0, 8)}`;
      }
    };
    const pollExe = async (ns: string) => {
      const items = await readPods(ns); if (!items) return;
      const now = new Set<string>();
      for (const pod of items) {
        const name = pod.metadata?.name as string; if (!name) continue; now.add(`${ns}/${name}`);
        const key = `${ns}/${name}`; let rec = pods.get(key);
        if (!rec) {
          const text = JSON.stringify(pod); const t = toolOfPod(pod);
          const mine = podBelongs(text, opts.runId);
          const c0 = (pod.spec?.containers || [])[0] || {}; const taskLbl = String(pod.metadata?.labels?.['whitebox.testable.cloud/task'] || '');
          rec = { tool: t.tool, toolFrom: t.from, task: taskLbl, image: String(c0.image || '').slice(0, 160), command: redact([...(c0.command || []), ...(c0.args || [])].slice(0, 5).join(' ')).slice(0, 160), pod: name, namespace: ns, seenFirst: new Date().toISOString(), seenLast: new Date().toISOString(), gone: false, consoleFile: '', consoleLines: 0, gaps: [], otherRun: !mine };
          pods.set(key, rec);
          if (!mine) continue; // another run's pod: nothing of it is stored
          const pd = path.join(dir, 'pods', safeName(name)); fs.mkdirSync(pd, { recursive: true });
          fs.writeFileSync(path.join(pd, 'pod.json'), redactJson(pod));
          rec.consoleFile = path.join('pods', safeName(name), 'console.log');
          kc(['describe', 'pod', name, '-n', ns], 20_000).then((d) => { if (d.code === 0) fs.writeFileSync(path.join(pd, 'describe.txt'), redact(d.out)); }).catch(() => {});
          const out = fs.createWriteStream(path.join(pd, 'console.log'), { flags: 'a' });
          const r2 = rec;
          follow(ns, name, (line) => {
            if (/^(error:|Error from server|Unable to retrieve)/i.test(line) || /^container ".*" in pod .* is waiting to start/i.test(line)) { fs.appendFileSync(path.join(pd, 'kubectl-notes.txt'), line + '\n'); return; } // kubectl's own messages are not the tool's output
            out.write(redact(line) + '\n'); r2.consoleLines++;
          }, name, async () => {
            const g = await kc(['get', 'pod', name, '-n', ns, '-o', 'json', '--request-timeout=10s'], 20_000);
            if (g.code === 0) { try { const pj = JSON.parse(g.out); updateRec(r2, pj); fs.writeFileSync(path.join(pd, 'pod.json'), redactJson(pj)); } catch (e) { warn(opts.branchDir, 'collector: pod.json', e); /* ignore */ } } else r2.gone = true;
          });
        }
        if (rec.otherRun) continue;
        const was = rec.phase; updateRec(rec, pod);
        if (rec.phase && rec.phase !== was && /Succeeded|Failed/.test(rec.phase)) {
          const pd = path.join(dir, 'pods', safeName(name));
          fs.writeFileSync(path.join(pd, 'pod.json'), redactJson(pod));
          kc(['describe', 'pod', name, '-n', ns], 20_000).then((d) => { if (d.code === 0) fs.writeFileSync(path.join(pd, 'describe.txt'), redact(d.out)); }).catch(() => {});
          kc(['get', 'events', '-n', ns, '--field-selector', `involvedObject.name=${name}`, '--request-timeout=10s'], 20_000).then((e) => { if (e.code === 0) fs.writeFileSync(path.join(pd, 'events.txt'), redact(e.out)); }).catch(() => {});
        }
      }
      for (const [k, rec] of pods) if (k.startsWith(`${ns}/`) && !now.has(k) && !rec.gone) rec.gone = true;
      resolveTools();
    };
    const pollServices = async () => {
      for (const ns of [...nsInfo.cell, ...nsInfo.global]) {
        const items = await readPods(ns); if (!items) continue;
        for (const pod of items) { const n = pod.metadata?.name as string; if (n && SERVICE_RE.test(n) && pod.status?.phase === 'Running') watchService(ns, n); }
      }
    };
    const snapshot = async () => {
      for (const ns of nsInfo.cell) {
        const r = await kc(['get', 'deploy', '-n', ns, '-o', 'json', '--request-timeout=10s'], 25_000); if (r.code !== 0) continue;
        try {
          const rt = (JSON.parse(r.out).items || []).filter((d: any) => /runtime|worker|orchestrator/.test(d.metadata?.name || '')).map((d: any) => ({ name: d.metadata.name, desired: d.spec?.replicas ?? 0, ready: d.status?.readyReplicas ?? 0 }));
          snapshotsLog.write(JSON.stringify({ at: new Date().toISOString(), ns, deployments: rt }) + '\n');
          for (const d of rt) if (d.desired === 0 && d.ready === 0 && /runtime|worker/.test(d.name)) scaledZero.add(d.name); else scaledZero.delete(d.name);
        } catch (e) { warn(opts.branchDir, 'collector: deployment snapshot', e); }
      }
    };

    // ----- start (in the background, so the test goes on at once)
    (async () => {
      let have = await kc(['config', 'current-context'], 15_000);
      if (have.code !== 0) { // the context is made here once you are signed in (same as npm run eks:setup); the aws profile qa-eks-ro is the one made with aws configure sso
        const mk = await new Promise<number>((res) => { try { execFile(clean(process.env.EKS_AWS_CLI) || 'aws', ['eks', 'update-kubeconfig', '--name', clean(process.env.EKS_CLUSTER_NAME) || 'qa-eks', '--region', clean(process.env.EKS_REGION) || 'us-east-2', '--alias', CTX], { env: eksEnv(), timeout: 60_000, windowsHide: true, shell: WIN }, (e) => res(e ? 1 : 0)); } catch { res(1); } });
        if (mk === 0) have = await kc(['config', 'current-context'], 15_000);
      }
      if (have.code !== 0) { say(`kubectl context ${CTX} is missing — run: npm run eks:setup (skipped, the run is not affected)`); return; }
      const ns = await kc(['get', 'ns', '-o', 'name', '--request-timeout=15s'], 25_000);
      if (ns.code !== 0) { say(`cluster not reachable (${/Expired|expired|sso|token/i.test(ns.out) ? 'sign-in expired: aws sso login --profile qa-eks-ro' : /timeout|deadline/i.test(ns.out) ? 'timeout: IP allow-list or VPN' : ns.out.trim().split('\n').pop()?.slice(0, 120)}) — skipped, the run is not affected`); notes.push('cluster not reachable at start'); return; }
      const names = ns.out.split(/\r?\n/).map((s) => s.replace(/^namespace\//, '').trim()).filter(Boolean);
      nsInfo = { exe: names.filter((n) => /-exe$/.test(n)), cell: names.filter((n) => /cell-\d+$/.test(n)), global: names.filter((n) => /^testable-qa-global$/.test(n)) };
      if (!nsInfo.exe.length && !nsInfo.cell.length) { say('no platform namespaces found (the cluster may have been rebuilt or is idle) — skipped'); notes.push('no platform namespaces'); return; }
      ctxOk = true; say(`following run ${short}: ${[...nsInfo.cell, ...nsInfo.exe, ...nsInfo.global].join(', ')} (read-only)`);
      const tick = async () => { for (const n of nsInfo.exe) await pollExe(n); };
      await pollServices(); await tick();
      timers.push(setInterval(() => { if (!stopped) tick().catch(() => {}); }, 2000));
      timers.push(setInterval(() => { if (!stopped) pollServices().catch(() => {}); }, 20_000));
      timers.push(setInterval(() => { if (!stopped) snapshot().catch(() => {}); }, 30_000));
      await snapshot();
    })().catch((e) => { notes.push(`start failed: ${e instanceof Error ? e.message : e}`); });

    const stop = async () => {
      if (stopped) return; stopped = true;
      try {
        for (const t of timers) clearInterval(t);
        if (ctxOk) for (const n of nsInfo.exe) await pollExe(n).catch(() => {}); // last look
        await new Promise((r) => setTimeout(r, 1500));
        for (const c of children) { try { c.kill(); } catch { /* ignore */ } }
        await Promise.all([servicesLog, snapshotsLog, ...raws.values()].map((w) => new Promise<void>((res) => { try { w.end(() => res()); } catch { res(); } })));
        resolveTools();
        const recs = [...pods.values()].filter((p) => !p.otherRun).map((p) => ({
          tool: p.tool, tool_from: p.toolFrom, task: p.task || '', image: p.image || '', command: p.command || '', pod: p.pod, namespace: p.namespace, node: p.node, phase: p.phase, exit_code: p.exitCode ?? null, reason: p.reason || '', message: p.message || '', restarts: p.restarts || 0,
          started: p.started || '', finished: p.finished || '', started_ist: p.started ? ist(p.started) : '', finished_ist: p.finished ? ist(p.finished) : '', first_seen_ist: ist(p.seenFirst), disappeared_before_stop: p.gone, console_file: p.consoleFile, console_lines: p.consoleLines,
        }));
        fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify(recs, null, 2));
        const stuck = waitRepeats >= 5;
        const plannedTools: Record<string, string> = {}; for (const v of planned.values()) if (v.tool) plannedTools[v.tool] = v.runtime || '';
        finding = matchRunPattern({ runId: opts.runId, waits: waitRepeats, waitFirst, waitLast, waitSample, waitRuntimes: [...runtimesWaiting], reasons: [...reasons], toolPods: recs.length, planned: planned.size || taskIds.size, scaledToZero: [...scaledZero], lastProgressMinutesAgo: Math.round((Date.now() - lastProgress) / 60000) });
        if (finding) fs.writeFileSync(path.join(dir, 'run-diagnosis.json'), JSON.stringify({ ...finding, waits: waitRepeats, first: waitFirst, last: waitLast }, null, 2));
        fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
          run_id: opts.runId, branch: opts.branch || '', collector_started_ist: ist(started), collector_stopped_ist: ist(Date.now()), cluster_reached: ctxOk, namespaces: nsInfo,
          tool_pods_seen: recs.length, other_runs_pods_ignored: [...pods.values()].filter((p) => p.otherRun).length, tasks_seen: taskIds.size,
          stuck_run: stuck ? { runtime_unavailable_waits: waitRepeats, runtimes: [...runtimesWaiting], first: waitFirst, last: waitLast } : null, planned_tools: plannedTools, task_events: Object.fromEntries([...planned.entries()].filter(([, v]) => v.tool).map(([k, v]) => [v.tool!, { task: k, runtime: v.runtime || '', last: v.last || '' }])), gaps, notes: netErrors > 3 ? [...notes, `${netErrors} cluster calls timed out in total (the PC's connection to the cluster API was slow; some polls were missed)`] : notes,
          missing: recs.length ? [] : [Date.now() - started < 150_000 ? `the run was over after ${Math.round((Date.now() - started) / 1000)} s and no tool pod appeared: most likely this commit was already analysed, so no tools ran again (use a branch with a NEW commit, or DUMMY_PR=yes, to get tool logs)` : 'no tool pod was seen: the run may have been too fast for polling, or the role cannot list pods in the -exe namespace (npm run eks:setup shows it)'],
        }, null, 2));
        buildRunReport(opts.branchDir); // run_summary.md, tools.csv, tools/<tool>/record.md
        say(ctxOk ? `saved ${recs.length} tool pod record(s)${stuck ? ` — STUCK RUN flagged (${waitRepeats} RUNTIME_UNAVAILABLE waits)` : ''} in ${path.join(path.basename(opts.branchDir), 'eks-live')}` : 'nothing captured (see above)');
      } catch (e) { console.log(`  QA EKS live: stop problem (${e instanceof Error ? e.message : e}) — the run is not affected`); }
    };
    const stuckNow = (): string | null => {
      if (stopped || !ctxOk || /^(off|no|0|false)$/i.test(clean(process.env.EKS_STUCK_STOP))) return null;
      const limit = (Number(process.env.EKS_STUCK_MIN) || 10) * 60_000;
      if (waitRepeats < (Number(process.env.EKS_STUCK_WAITS) || 150) || [...pods.values()].some((p) => !p.otherRun) || Date.now() - lastProgress < limit) return null;
      const f = matchRunPattern({ runId: opts.runId, waits: waitRepeats, waitFirst, waitLast, waitSample, waitRuntimes: [...runtimesWaiting], reasons: [...reasons], toolPods: 0, planned: planned.size || taskIds.size, scaledToZero: [...scaledZero] });
      return `platform stuck run: ${f ? f.short : `${waitRepeats} RUNTIME_UNAVAILABLE waits, no progress for ${Math.round((Date.now() - lastProgress) / 60000)} min`} (stopped waiting early; details in eks-live/run_summary.md)`;
    };
    return { stop, enabled: true, stuck: stuckNow, diagnosis: () => finding };
  } catch (e) { console.log(`  QA EKS live: not started (${e instanceof Error ? e.message : e})`); return off; }
}
