import './env'; // loads .env
import { loadBuilds } from './builds';
import { pushDummyCommit, ownerAndName, tokenFor, findGh, installGh, realGh, diagnoseGh } from './dummyCommit';

/**
 * Tries ONLY the dummy commit, without running the test:   npm run dummy -- <part of a branch name>
 * Without a name it does every branch of builds.json. It REALLY pushes one new commit to each branch it is given.
 *   npm run dummy -- --diagnose <part of a branch name>   only finds out WHY the token does or does not work (no commit; one invisible test object is written)
 */
const diagnoseOnly = process.argv.includes('--diagnose');
const want = process.argv.slice(2).find((a) => !a.startsWith('--'));
const builds = loadBuilds().filter((b) => !want || b.branch.toLowerCase().includes(want.toLowerCase()));
if (!builds.length) { console.log(`No branch of builds.json matches "${want}".`); process.exit(1); }
if (diagnoseOnly) {
  for (const b of builds) {
    const slug = ownerAndName(b.repo) || b.repo; const token = tokenFor(slug.split('/')[0]);
    console.log(`== ${slug}  (${b.branch})`);
    if (!token) { console.log('   ✗ no token in .env for this owner (GH_TOKEN or GH_TOKEN_<OWNER>)\n'); continue; }
    const gh = findGh() || installGh((m) => console.log(`   ${m}`));
    if (!gh) { console.log('   ✗ the GitHub CLI is not available\n'); continue; }
    const d = diagnoseGh(slug, token, realGh(gh, token));
    d.lines.forEach((l) => console.log(`   ${l}`)); console.log(d.cause ? `   ROOT CAUSE: ${d.cause}\n` : '   → all checks passed\n');
  }
  process.exit(0);
}
console.log(`\nDummy commit only (${builds.length} branch(es)); this really pushes a new commit to each.\n`);
let ok = 0;
for (const b of builds) {
  console.log(`== ${b.branch}`);
  const r = pushDummyCommit(b.repo, b.branch);
  if (r.sha) ok++;
  console.log(`   result: ${r.sha ? `NEW COMMIT ${r.sha.slice(0, 8)} via ${r.via}${r.verified ? ', checked on GitHub' : ''}` : `nothing pushed (${r.reason || 'unknown'})`}\n`);
}
console.log(`${ok}/${builds.length} branch(es) got a new commit.`);
process.exit(ok === builds.length ? 0 : 1);
