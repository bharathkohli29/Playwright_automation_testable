// Writes the answer for every case of an export (results/rca-dataset/<dir>/facts.jsonl) from its FACTS, in plain English, class by class.
// Used once to make the v0 training set (the answers are authored here, not copied from the model drafts, which contradicted their own facts).
// Usage: node rca-train/author_v0.js <export dir>      -> <dir>/authored.json   { id: {oneLine, whatHappened, why, impact, fix, category} }
// Every sentence only uses what the facts of that case say; unknown causes are said to be unknown.
const fs = require('fs'); const path = require('path');
const dir = path.resolve(process.argv[2]);
const facts = new Map(fs.readFileSync(path.join(dir, 'facts.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.id, j]; }));
const ids = JSON.parse(fs.readFileSync(path.join(dir, 'subset-ids.json'), 'utf8'));
const LANG = { python: 'Python', java: 'Java', typescript: 'Node', csharp: 'C#' };
const out = {}; const skipped = [];

for (const id of ids) {
  const x = facts.get(id); const u = x.user; const tool = x.tool;
  const lang = LANG[(/^TOOL: [^\n(]+\((\w+) /m.exec(u) || [])[1]] || 'the language'; const L = `${lang} <V>`;
  const s3 = /^S3 RESULT: (\[[^\]]+\]) (\w+): (.*)$/m.exec(u); const note = s3 ? s3[3] : '';
  const hasKC = /^KNOWN CAUSE \(by a rule/m.test(u);
  const noCapture = /no live capture/.test(u);
  const pods = [...u.matchAll(/^\d+\. (Succeeded|Failed), exit code (\S+), command "([^"]*)"/gm)].map((m) => ({ phase: m[1], exit: m[2], cmd: m[3] }));
  let r = null; let cat = '';
  const none = `${tool} has no usable result for this branch.`;
  const missing = `${tool} is missing from this branch's quality score input.`;

  if (/FOREIGN_TOOL_PLANNED/.test(u)) {
    cat = 'contamination'; const fj = /^- failure\.json: ([^\n]*)$/m.exec(u);
    r = { oneLine: `${tool} is not a ${lang} tool, but it was planned for this ${lang} branch.`,
      whatHappened: [`The S3 check flagged ${tool} as FOREIGN_TOOL_PLANNED: a non-${lang === 'Node' ? 'TypeScript' : lang} tool planned for a ${lang === 'Node' ? 'TypeScript Node' : lang} <V> branch.`, ...(fj ? [`It also failed: ${fj[1].replace(/ · /g, ', ')}.`] : []), 'No log line says why planning picked it.'],
      why: `The planning step scheduled a tool that belongs to another language for a ${lang} <V> branch. The language filter in planning should have left it out. The facts do not show why it did not.`,
      impact: `The result of ${tool} does not belong in this branch's quality score.`, fix: `Make planning skip tools of other languages for ${lang} branches, then re-run.` };
  } else if (/RAN_BUT_EXCLUDED/.test(u)) {
    cat = 'ran-excluded'; const why = /although it must be excluded \((.*)\)$/.exec(note); const reason = why ? why[1] : 'the tool matrix excludes it';
    r = { oneLine: `${tool} ran on ${L} although the tool matrix says it must not.`,
      whatHappened: [`${tool} was triggered and ran on this branch.`, `The tool matrix excludes it for ${L}: ${reason}.`],
      why: `The platform planned and ran a tool that its own compatibility matrix excludes for this version. The matrix gives the reason above, so the tool should not have been scheduled.`,
      impact: `A result exists that should not count for ${L}.`, fix: `Align the planning step with the compatibility matrix for ${L}, or update the matrix if ${tool} is meant to run.` };
  } else if (/only reported not_applicable/.test(u)) {
    cat = 'not-applicable'; const rs = /\((\w+)\)$/.exec(note);
    r = { oneLine: `${tool} ran but reported "not applicable" for this ${lang} branch.`,
      whatHappened: [`${tool} was triggered and wrote a result.`, `The result says not_applicable${rs ? ` with the reason ${rs[1]}` : ''}.`, `${tool} is expected for ${L}, so the S3 check counts this as a defect.`],
      why: `${tool} found no usable input file${rs && /missing_or_empty/.test(rs[1]) ? ' (the file it needs was missing or empty)' : ''} and so reported that it does not apply. Whether the repository really lacks that file or the platform did not provide it is not shown in the facts.`,
      impact: `${tool} gives no result for this branch's quality score.`, fix: `Check which input file ${tool} expects, whether it exists in the repository, and whether it reached the runner, then re-run.` };
  } else if (/False Empty/.test(u)) {
    cat = 'false-empty'; const d = /scanned: (.*?) — nothing was analysed although the repo has (\w+) files/.exec(note);
    r = { oneLine: `${tool} finished, but its report is empty: it analysed nothing.`,
      whatHappened: [`${tool} was triggered for ${L} and wrote a result file.`, `The S3 check found it empty: ${d ? d[1] : 'no files were scanned'}.`, `The repository does contain ${d ? d[2] : lang} files, so there was something to analyse.`, 'No log line of this tool was captured, so the log does not show why.'],
      why: `${tool} ended without an error but scanned 0 files, although the repository has ${d ? d[2] : lang} files. That points at how the tool finds its input files, but the facts do not confirm it.`,
      impact: `The part of the quality score that depends on ${tool} is not based on real data.`, fix: `Check how ${tool} finds the repository's ${d ? d[2] : lang} files for this branch, then re-run it.` };
  } else if (hasKC && /Failed to upgrade/.test(u)) {
    cat = 'pip-audit'; const p = pods.find((q) => q.phase === 'Failed');
    r = { oneLine: `${tool} stopped before it audited anything: it could not set up its own environment.`,
      whatHappened: [`${tool} ran once and ended as Failed with exit code ${p ? p.exit : '1'}.`, 'Its own message: it failed to upgrade pip in a temporary environment (pip install --upgrade pip wheel setuptools).', 'The result of the tool is empty.'],
      why: `${tool} first builds a temporary virtual environment and upgrades pip inside it. That step failed, so the tool never audited any dependency. The log does not say why pip failed. The usual causes are no access to the package index from the runner, or a temporary folder the runner cannot use.`,
      impact: 'No dependency audit result exists for this branch.', fix: `Run the same pip command inside the runner and read pip's own error. Give the runner access to the package index or a mirror, then re-run.` };
  } else if (hasKC && /No such option/.test(u)) {
    cat = 'cli-option'; const o = /No such option:? '?(--?[\w-]+)/.exec(u);
    r = { oneLine: `${tool} stopped at one step because the runner used an option the tool does not have.`,
      whatHappened: [`${tool} ran ${pods.length} steps${pods.length ? ` (${pods.map((q) => q.cmd.split(' ')[1] || q.cmd).join(', ')})` : ''}.`, `One step failed with exit code ${(pods.find((q) => q.phase === 'Failed') || {}).exit || '2'}; the others succeeded.`, `Its own message: No such option '${o ? o[1] : ''}'.`],
      why: `The runner starts that step with the option ${o ? o[1] : 'shown above'}, but the version of ${tool} installed in the image does not have it, so the step stopped at once. The runner command and the installed tool version do not match.`,
      impact: `Part of the result of ${tool} may be missing for this branch, because one of its steps failed.`, fix: `Remove ${o ? o[1] : 'the option'} from the runner command, or install the ${tool} version that supports it, then re-run.` };
  } else if (hasKC && /Permission denied/.test(u)) {
    cat = 'permission'; const fromS3 = /traversal failed/.test(u); const lock = /config\.lock/.test(u);
    r = { oneLine: `${tool} failed because the runner is not allowed to write in the checked-out repository.`,
      whatHappened: fromS3 ? [`${tool} was triggered and ended as failed in S3 (failure.json).`, `Its own message: permission denied (Errno 13) on ${lock ? '.git/config.lock' : 'a file'} in the checked-out repository under /workspaces.`]
        : [`${tool} ran ${pods.length} steps${pods.length ? `: ${pods.map((q) => `${q.cmd.split(' ')[0] === 'python' ? 'python -m compileall' : q.cmd.split(' ')[0]} ${q.phase.toLowerCase()}`).join(', ')}` : ''}.`, 'The failed step printed "Permission denied" (Errno 13) while compiling files in the checked-out repository under /workspaces.'],
      why: `The runner user is not allowed to write in the checked-out repository folder under /workspaces. A tool that needs to write there fails with "Permission denied". This is a platform problem, not a problem of the repository, and every tool that writes into the checkout hits the same error.`,
      impact: none, fix: 'Make the checked-out repository under /workspaces writable for the runner user, or run the tool on a copy of it, then re-run.' };
  } else if (/permanent_runner_error|parse_error/.test(u) && !hasKC) {
    cat = 'runner-failure'; const fj = /^- failure\.json: ([^\n]*)$/m.exec(u); const msg = fj ? fj[1].split(' · ').slice(2).join(' · ').trim() : '';
    const parse = /Failed to parse ([\w.]+)(?: JSON)?: Expecting value: line (\d+) column (\d+)/.exec(msg); const noOut = /produced no output \(exit=(\d+)\)/.exec(msg);
    r = noOut ? { oneLine: `${tool} failed: it exited with code ${noOut[1]} and wrote no output.`, whatHappened: [`${tool} was triggered and ended as failed in S3 (failure.json, permanent_runner_error).`, `Its own message: ${msg.replace(/:\s*$/, '')}.`, 'No log line of this tool was captured.'],
      why: `${tool} ended with exit code ${noOut[1]} and produced no output at all, so the runner had nothing to read. The facts do not show what the tool printed or why it stopped.`, impact: none, fix: `Run ${tool} on this branch with the live capture on and read its pod log to see what it printed, then re-run.` }
      : { oneLine: `${tool} failed because the platform could not read its report.`, whatHappened: [`${tool} was triggered and ended as failed in S3 (failure.json).`, `Its own message: ${msg || 'a parse error'}.`, 'No log line of this tool was captured.'],
      why: parse ? `The platform tried to read the JSON report of ${tool} and could not: it found nothing readable at line ${parse[2]}, column ${parse[3]}. That means the report was empty or not valid JSON. The facts do not show why the tool wrote no valid report.` : `The platform could not read the report of ${tool}. The facts do not show why.`,
      impact: none, fix: `Open the pod log of ${tool} for this run to see what it printed, and check why it wrote no valid JSON report, then re-run.` };
  } else if (/planning\.tools_unplaceable/.test(u)) {
    cat = 'unplaceable'; const c = /satisfies_its_([A-Z_]+)_coupling/.exec(u); const co = c ? c[1] : 'compatibility';
    r = { oneLine: `${tool} was never started because the platform had no runtime to run it on.`,
      whatHappened: [`The orchestrator's planning found ${tool} eligible for ${L}.`, `It then listed ${tool} as unplaceable with the reason EXECUTION_RUNTIME_UNAVAILABLE.`, `The detail says that no available runtime satisfies its ${co} coupling.`, 'No pod of this tool was created.'],
      why: `Planning wanted to run ${tool}, but no execution runtime in the cell matched what the tool needs (its ${co} coupling), so the task was never started. This is a platform availability problem, not a problem of the repository.`,
      impact: missing, fix: `Make sure a runtime that fits the ${co} coupling of ${tool} is available in the cell during the run, then re-run.` };
  } else if (/worker\.tool_readiness_blocked_execution/.test(u)) {
    cat = 'readiness'; const rs = /readiness_status=(\w+)/.exec(u); const sr = /skip_reason=(\w+)/.exec(u);
    r = { oneLine: `${tool} was blocked by the worker's start-up check: the tool is not installed.`,
      whatHappened: [`A worker received the task for ${tool}.`, `Its readiness check reported ${rs ? rs[1] : 'a problem'}${sr ? ` with the reason ${sr[1]}` : ''}, so it refused to run the tool.`, 'No pod of this tool was created.'],
      why: `The worker checks that a tool is installed before it runs it. For ${tool} that check failed${sr ? ` (${sr[1]})` : ''}, so the task was never executed. This is the installation of the tool on the worker, not a problem of the repository.`,
      impact: missing, fix: `Install the missing binary in the worker image, or fix the check, then re-run.` };
  } else if (/planning\.tools_skipped_startup_readiness/.test(u)) {
    cat = 'skipped-readiness';
    r = { oneLine: `${tool} was skipped in planning because its start-up readiness check did not pass.`,
      whatHappened: [`The orchestrator listed ${tool} under skipped tools (planning.tools_skipped_startup_readiness).`, 'So no task was created for it and no pod ran.'],
      why: `Planning skips a tool whose start-up readiness check fails. ${tool} was on that list, so it never started. The facts do not say what the check found.`,
      impact: missing, fix: `Find out why the readiness check of ${tool} fails on the workers (a missing binary or runtime), then re-run.` };
  } else if (/admission_rejected_task/.test(u)) {
    cat = 'admission'; const env = /environment_id=([\w-]+)/.exec(u);
    r = { oneLine: `${tool} was never started: the cell had no free CPU capacity for it.`,
      whatHappened: [`The orchestrator rejected the task of ${tool} at admission (dispatch.admission_rejected_task).`, `The reason was CELL_CPU_CAPACITY${env ? ` for the environment ${env[1]}` : ''}.`, 'No pod of this tool was created.'],
      why: `The admission step refused the task because the cell's CPU capacity was used up at that moment. So ${tool} was never started. This is capacity at that time, not a problem of the repository.`,
      impact: missing, fix: 'Check the CPU capacity of the cell during the run (other runs, replicas) and re-run when capacity is free. Raise the capacity if this repeats.' };
  } else if (/was not triggered/.test(note)) {
    cat = 'not-triggered';
    r = { oneLine: `${tool} was expected for ${L} but never ran.`,
      whatHappened: [`The S3 check found no folder for ${tool} in this run, so it was not triggered.`, `${tool} is on the expected tool list for ${L}.`, noCapture ? 'There is no live capture of this run, so no pod or log line exists.' : 'No pod and no log line of this tool were captured.'],
      why: `No task was created for ${tool}, so it never reached a worker. That points at the planning step, before any worker started. This is inferred from what is missing; no log line states the reason.`,
      impact: missing, fix: `Check why planning left ${tool} out for ${L} (a version limit or a compatibility entry), then re-run.` };
  } else if (/EMPTY RESULT/.test(u) && !s3) {
    cat = 'empty-unknown';
    r = { oneLine: `${tool}'s result is empty, and the cause is not known.`,
      whatHappened: [`${tool} was triggered and its result is empty in the S3 check.`, noCapture ? 'There is no live capture of this run, so no pod or log line exists.' : 'No log line of this tool was captured.'],
      why: 'The facts only say that the result is empty. No log lines exist for this tool, so no cause can be stated.',
      impact: `The part of the quality score that depends on ${tool} is not based on real data.`, fix: 'Run the branch with the live capture on, so the pod and service lines exist, then read them.' };
  }
  if (r) out[id] = { ...r, category: cat }; else skipped.push(id);
}
fs.writeFileSync(path.join(dir, 'authored.json'), JSON.stringify(out, null, 1));
const byCat = {}; Object.values(out).forEach((v) => { byCat[v.category] = (byCat[v.category] || 0) + 1; });
console.log('authored', Object.keys(out).length, 'of', ids.length, byCat); if (skipped.length) console.log('NOT authored (no matching class):', skipped.join(', '));
