"""
Register a newly trained GGUF as an Ollama model and compare it with the current one.

  python register_model.py <path\\to\\new.gguf> [--name qa-eks-mentor-v3] [--promote]
  python register_model.py --eval <ollama model name>          (only run the test cases on an existing model)

What it does:
  1. checks the file really is a GGUF and REFUSES it when its weights are identical to the model already registered (nothing was trained);
  2. builds a Modelfile from this folder's Modelfile with FROM pointing at the new file, and runs `ollama create <name>`;
  3. runs the fixed RCA test cases from RCA_PROMPT.md on the current model and on the new one;
  4. --promote: only when the new model passes every check, keeps the old one as qa-eks-mentor-trained-prev and copies the new one over qa-eks-mentor-trained.
Local only. Nothing is sent anywhere except to Ollama on this PC.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = pathlib.Path(__file__).parent
CURRENT = "qa-eks-mentor-trained"

SYSTEM = """You are the Whitebox QA RCA writer for the Testable platform. For ONE tool of ONE run you write a short root cause analysis (RCA), using ONLY the INPUT block you are given.

CRITICAL SPECIAL CASE:
If STATE is OUTPUT, the tool succeeded. Do NOT output an RCA or use the template. Output ONLY this exact sentence and nothing else:
No RCA needed: the tool produced output.

The tool is in one of these states:
- NOT_TRIGGERED: the platform produced no output folder for the tool.
- EMPTY: the tool ran but its output is empty ([] or {} or all zeros).
- FAILED: the tool ran but reported a failure or its output could not be parsed.
- SKIPPED: the tool itself said "not applicable" or "skipped".
- OUTPUT: the tool produced output.

VERDICT MAPPING:
- If STATE is OUTPUT: Output ONLY "No RCA needed: the tool produced output."
- If worker.tool_readiness_blocked_execution is in logs: Verdict is "Blocked at startup"
- If planning exclusion or compatibility_excluded is in logs: Verdict is "Excluded in planning"
- If handler.failed or error is in logs: Verdict is "Tool failed"
- If tool skipped itself: Verdict is "Skipped by the tool"
- If LOG EVIDENCE is "none" or no log names the tool: Verdict is "Insufficient evidence"

RULES:
1. Use only facts that are in the INPUT block. Copy tool names, service names, pod names, run ids, reason codes and timestamps exactly, character by character. Never retype them from memory.
2. Quote at most 3 evidence lines, the ones that decide the cause.
3. If the evidence does not show the cause, the Verdict is "Insufficient evidence" and the Root cause says what is missing. Do not guess. Never write: probably, maybe, might, could be, likely, possibly, perhaps, transient, "customer repo".
4. Owner: the platform component that the evidence names (a service or check). If no component is named, write "Unknown".
5. Action: one line that follows directly from the evidence. If there is no evidence, the action is to collect the missing evidence.
6. Acceptance: one line that can be checked after the fix.
7. No preamble, no thinking aloud, no headings other than the template, no lists other than the Evidence lines. Maximum 120 words.
8. If LOG EVIDENCE is none:
Evidence:
- none

OUTPUT TEMPLATE:
RCA: <tool> - <STATE>
Verdict: <Blocked at startup | Excluded in planning | Tool failed | Tool produced empty output | Skipped by the tool | Insufficient evidence>
Root cause: <one sentence>
Evidence:
- <time> <LEVEL> <service>: <message> (<key fields>)
Owner: <component or Unknown>
Action: <one line>
Acceptance: <one line>

EXAMPLES:

Example 1:
INPUT
TOOL: cdxgen
STATE: NOT_TRIGGERED
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: no folder
LOG EVIDENCE:
18:00:56 ERROR wb-cpu-worker: worker.tool_readiness_blocked_execution (tool_name=cdxgen readiness_status=NOT_APPLICABLE language=typescript skip_reason=FAILED_STARTUP_CHECK:NOT_APPLICABLE queue=wb.exec.cpu.cell-001.worker-node-20)
POD STATE: all Running, 0 restarts

RCA: cdxgen - NOT_TRIGGERED
Verdict: Blocked at startup
Root cause: The worker readiness check for cdxgen returned NOT_APPLICABLE on Node 20 queue, blocking execution.
Evidence:
- 18:00:56 ERROR wb-cpu-worker: worker.tool_readiness_blocked_execution (tool_name=cdxgen readiness_status=NOT_APPLICABLE skip_reason=FAILED_STARTUP_CHECK:NOT_APPLICABLE)
Owner: wb-cpu-worker
Action: Review startup check of cdxgen on Node 20 queue.
Acceptance: On re-run, worker.tool_readiness_blocked_execution is not logged for cdxgen and S3 output exists.

Example 2:
INPUT
TOOL: biome
STATE: FAILED
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: status=failed (parse error: Failed to parse biome JSON: Expecting value: line 1 column 1 (char 0))
LOG EVIDENCE:
18:00:27 WARNING wb-cpu-worker: handler.failed (tool_name=biome reason=parse error: Failed to parse biome JSON: Expecting value: line 1 column 1 (char 0))
POD STATE: all Running, 0 restarts

RCA: biome - FAILED
Verdict: Tool failed
Root cause: biome failed with JSON parse error at line 1 column 1.
Evidence:
- 18:00:27 WARNING wb-cpu-worker: handler.failed (tool_name=biome reason=parse error: Failed to parse biome JSON: Expecting value: line 1 column 1 (char 0))
Owner: wb-cpu-worker
Action: Inspect why biome returned non-JSON output on this repository.
Acceptance: On re-run, handler.failed is not logged for biome and S3 output is valid JSON.

Example 3:
INPUT
TOOL: lizard
STATE: EMPTY
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: []
LOG EVIDENCE: none
POD STATE: all Running, 0 restarts

RCA: lizard - EMPTY
Verdict: Insufficient evidence
Root cause: lizard ran and returned empty list, and no log lines name lizard.
Evidence:
- none
Owner: Unknown
Action: Collect the lizard task log of this run and the list of files it was given.
Acceptance: lizard writes non-empty result or logs show why no files were analyzed.

Example 4:
INPUT
TOOL: eslint
STATE: OUTPUT
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: [{"filePath": "index.ts", "messages": []}]
LOG EVIDENCE: none
POD STATE: all Running, 0 restarts

No RCA needed: the tool produced output.
"""

BANNED_WORDS = ["probably", "maybe", "might", "could be", "likely", "possibly", "perhaps", "transient", "customer repo"]

# Worked examples from Section 4 of RCA_PROMPT.md
CASE_CDXGEN = """INPUT
TOOL: cdxgen
STATE: NOT_TRIGGERED
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: no folder
LOG EVIDENCE:
18:00:56 ERROR wb-cpu-worker: worker.tool_readiness_blocked_execution (tool_name=cdxgen readiness_status=NOT_APPLICABLE language=typescript skip_reason=FAILED_STARTUP_CHECK:NOT_APPLICABLE queue=wb.exec.cpu.cell-001.worker-node-20)
POD STATE: all Running, 0 restarts"""

CASE_BIOME = """INPUT
TOOL: biome
STATE: FAILED
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: status=failed (parse error: Failed to parse biome JSON: Expecting value: line 1 column 1 (char 0))
LOG EVIDENCE:
18:00:27 WARNING wb-cpu-worker: handler.failed (tool_name=biome reason=parse error: Failed to parse biome JSON: Expecting value: line 1 column 1 (char 0))
POD STATE: all Running, 0 restarts"""

CASE_LIZARD = """INPUT
TOOL: lizard
STATE: EMPTY
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: []
LOG EVIDENCE: none
POD STATE: all Running, 0 restarts"""

CASE_OUTPUT = """INPUT
TOOL: eslint
STATE: OUTPUT
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: [{"filePath": "index.ts", "messages": []}]
LOG EVIDENCE: none
POD STATE: all Running, 0 restarts"""

CASE_NO_EVID = """INPUT
TOOL: semgrep
STATE: NOT_TRIGGERED
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: no folder
LOG EVIDENCE: none
POD STATE: all Running, 0 restarts"""

# (name, input_block, must_contain, banned)
CASES = [
    ("cdxgen (blocked startup)", CASE_CDXGEN, ["Blocked at startup", "cdxgen", "wb-cpu-worker"], BANNED_WORDS),
    ("biome (tool failed)", CASE_BIOME, ["Tool failed", "biome"], BANNED_WORDS),
    ("lizard (empty, no evid)", CASE_LIZARD, ["Insufficient evidence", "lizard", "Unknown"], BANNED_WORDS),
    ("eslint (output produced)", CASE_OUTPUT, ["No RCA needed: the tool produced output."], BANNED_WORDS),
    ("semgrep (not triggered, no evid)", CASE_NO_EVID, ["Insufficient evidence", "semgrep", "Unknown"], BANNED_WORDS),
]

ID_LIKE = re.compile(r"[A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+){2,}")  # pod names, run ids, service names ...


def sha256(path, chunk=8 * 1024 * 1024):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, encoding="utf-8", errors="replace")


def model_weights_sha(name):
    out = sh("ollama", "show", name, "--modelfile").stdout
    m = re.search(r"^FROM .*sha256-([0-9a-f]{64})", out, re.M)
    return m.group(1) if m else None


def ask(model, input_block):
    body = {
        "model": model,
        "stream": False,
        "think": False,
        "options": {"temperature": 0.1, "num_ctx": 4096, "num_predict": 300},
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": input_block}
        ]
    }
    req = urllib.request.Request("http://localhost:11434/api/chat", json.dumps(body).encode(), {"Content-Type": "application/json"})
    t = time.time()
    return json.load(urllib.request.urlopen(req, timeout=300))["message"]["content"].strip(), time.time() - t


def grade(answer, facts, must, banned):
    bad = []
    words = answer.split()
    if len(words) > 120:
        bad.append(f"exceeds 120 words ({len(words)} words)")
    for m in must:
        if m.lower() not in answer.lower():
            bad.append(f"missing '{m}'")
    for b in banned:
        if re.search(r"\b" + re.escape(b) + r"\b", answer, re.IGNORECASE):
            bad.append(f"speculation '{b}'")
    # Check template headers when RCA is required
    if "no rca needed" not in answer.lower():
        required_headers = ["rca:", "verdict:", "root cause:", "evidence:", "owner:", "action:", "acceptance:"]
        missing_headers = [h for h in required_headers if h not in answer.lower()]
        if missing_headers:
            bad.append(f"missing template fields: {', '.join(missing_headers)}")
    for tok in set(ID_LIKE.findall(answer)):
        if tok not in facts:
            bad.append(f"invented id '{tok}'")  # a name / id not in the evidence
    return bad


def evaluate(models):
    print(f"\nRCA Prompt Test Cases ({len(CASES)} from RCA_PROMPT.md); PASS = all required text present, template adhered, <=120 words, no speculation, no invented ids.\n")
    totals = {m: 0 for m in models}
    for name, input_block, must, banned in CASES:
        print(f"== {name}")
        for m in models:
            try:
                a, s = ask(m, input_block)
            except Exception as e:  # noqa: BLE001
                print(f"  [{m}] ERROR {e}")
                continue
            bad = grade(a, input_block, must, banned)
            totals[m] += 0 if bad else 1
            print(f"  [{m}] {'PASS' if not bad else 'FAIL ' + '; '.join(bad)}  ({s:.1f}s)\n      {a[:260]!r}")
    print("\nScore: " + ", ".join(f"{m} {totals[m]}/{len(CASES)}" for m in models))
    return totals


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("gguf", nargs="?")
    ap.add_argument("--name", default="qa-eks-mentor-v3")
    ap.add_argument("--promote", action="store_true")
    ap.add_argument("--eval", dest="eval_model")
    a = ap.parse_args()
    if a.eval_model:
        evaluate([a.eval_model])
        return
    if not a.gguf:
        ap.error("give the path of the new .gguf, or --eval <model>")
    p = pathlib.Path(a.gguf).resolve()
    if not p.is_file() or p.stat().st_size < 500_000_000 or p.open("rb").read(4) != b"GGUF":
        sys.exit(f"{p} is not a GGUF model file (missing, under 500 MB, or wrong header).")
    print(f"Hashing {p.name} ({p.stat().st_size / 1e9:.2f} GB) ...")
    new_sha, cur_sha = sha256(p), model_weights_sha(CURRENT)
    print(f"  new file : {new_sha}\n  {CURRENT}: {cur_sha}")
    if new_sha == cur_sha:
        sys.exit("\nThese are the SAME weights as the model already registered: nothing new was trained. Not registering.")
    mf = (HERE / "Modelfile").read_text(encoding="utf-8")
    mf = re.sub(r"^FROM .*$", lambda _m: "FROM " + str(p), mf, count=1, flags=re.M)
    with tempfile.NamedTemporaryFile("w", suffix=".Modelfile", delete=False, encoding="utf-8") as f:
        f.write(mf)
        tmp = f.name
    print(f"\nollama create {a.name} ...")
    r = sh("ollama", "create", a.name, "-f", tmp)
    print((r.stdout + r.stderr).strip()[-400:])
    if r.returncode != 0:
        sys.exit("ollama create failed")
    print(f"Registered {a.name}; weights {model_weights_sha(a.name)}")
    totals = evaluate([CURRENT, a.name])
    if a.promote:
        if totals[a.name] < len(CASES) or totals[a.name] < totals[CURRENT]:
            sys.exit(f"\nNot promoted: {a.name} must pass all {len(CASES)} cases and not score below {CURRENT}.")
        sh("ollama", "cp", CURRENT, CURRENT + "-prev")
        sh("ollama", "cp", a.name, CURRENT)
        print(f"\nPromoted: {CURRENT} is now {a.name}; the old one is kept as {CURRENT}-prev.")
        mj = HERE / "model.json"
        m = json.loads(mj.read_text(encoding="utf-8"))
        m.update({"version": str(int(m.get("version", "0")) + 1), "sha256": new_sha, "file": p.name})
        mj.write_text(json.dumps(m, indent=2) + "\n", encoding="utf-8")
        print(f"model.json updated (version {m['version']}). Upload {p.name} to the address in model.json 'url', then commit model.json.")
    else:
        print(f"\nNot promoted (run again with --promote, or: ollama cp {a.name} {CURRENT}).")


if __name__ == "__main__":
    main()
