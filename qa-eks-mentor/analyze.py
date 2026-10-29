"""Whitebox 'tool not triggered' analysis report for one run + tool, from QA EKS logs.

Code extracts the facts and fills the report; the Ollama model only writes the short summary.

Usage: python analyze.py --run-id <id> --tool <name> [--facts facts.md] [--since 72h] [--model qa-eks-mentor] [--no-llm]
Needs: kubectl context qa-eks-ro (aws sso login done); ollama running unless --no-llm.
"""
import argparse
import functools
import json
import pathlib
import re
import subprocess
import urllib.request
from xml.sax.saxutils import escape

NS = "whitebox-cell-001"
DEPLOYS = ["cell-001-wb-orchestrator", "cell-001-ingestion-api", "cell-001-ingestion-worker",
           "cell-001-runtime-api", "cell-001-wb-cpu-worker", "cell-001-wb-io-worker",
           "cell-001-scoring-worker", "cell-001-projector-worker", "cell-001-reconciliation-worker"]
KEEP = ["timestamp", "level", "logger", "message", "run_id", "tenant_id", "error", "exception"]
SIGNAL = ("exclu", "incompat", "skip", "fail", "error", "denied", "timeout", "unresolved")

# reason code -> (what it means, who owns the fix, action). Extend as new reasons are diagnosed.
REASONS = {
    "CUSTOMER_CODE_INCOMPATIBLE_WITH_EXECUTION_ENV": (
        "the planner could not prove the customer code version is compatible with any execution environment, "
        "so it dropped every tool that executes customer code",
        "Platform (wb-orchestrator environment resolution)",
        "Find out why the customer code version stays unresolved/non-exact for this repo and fix the resolution "
        "(or pin exact versions in the repo's lockfile); then confirm the tool lands on an eligible worker environment."),
}


def sh(*args):
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace").stdout


# ---------------------------------------------------------------- collection
def compact_excluded(ex):
    out = {k: ex.get(k) for k in ("tool_name", "tool_version", "verdict", "reason", "detail", "runtime_coupling", "remediation")}
    out["axes"] = [{"axis": a.get("axis"), "verdict": a.get("verdict"), "detail": a.get("detail")} for a in ex.get("axes", [])]
    return out


def compact(line, tool):
    try:
        d = json.loads(line)
    except ValueError:
        return None
    out = {k: d[k] for k in KEEP if k in d}
    if "excluded" in d:
        out["excluded"] = [compact_excluded(e) for e in d["excluded"] if e.get("tool_name") == tool]
    return out


@functools.lru_cache(maxsize=None)
def log_lines(dep, since):
    """Current container plus the one before a restart (a restart drops older logs from the current one).
    Cached so analysing several tools in one run fetches each service's logs once."""
    return tuple(sh("kubectl", "logs", "-n", NS, f"deploy/{dep}", "--previous", "--tail=-1").splitlines()
                 + sh("kubectl", "logs", "-n", NS, f"deploy/{dep}", f"--since={since}", "--tail=-1").splitlines())


def collect(run_id, tool, since):
    """Returns (events mentioning the run, events mentioning the tool in other runs, earliest log timestamp seen)."""
    short = run_id.split("-")[0]
    on_run, other, earliest = [], [], None
    for dep in DEPLOYS:
        for line in log_lines(dep, since):
            m = re.search(r'"timestamp": "([^"]+)"', line)
            if m and (earliest is None or m.group(1) < earliest):
                earliest = m.group(1)
            if short not in line and tool not in line:
                continue
            c = compact(line, tool)
            if not c:
                continue
            c["service"] = dep
            (on_run if short in line else other).append(c)
    return rank(on_run), rank([e for e in other if "excluded" in e]), earliest


def rank(events):
    """Decisive events first, one event per message (exclusions always kept)."""
    def score(e):
        text = (e.get("message", "") + e.get("level", "")).lower()
        return 0 if e.get("excluded") else 1 if any(s in text for s in SIGNAL) or e.get("level") in ("WARNING", "ERROR") else 2
    seen, out = set(), []
    for e in sorted(events, key=lambda e: (score(e), e.get("timestamp", ""))):
        if e.get("message") in seen and not e.get("excluded"):
            continue
        seen.add(e.get("message"))
        out.append(e)
    return out


def pod_findings():
    findings = []
    for line in sh("kubectl", "get", "pods", "-n", NS, "--no-headers").splitlines():
        p = line.split()
        if len(p) < 4:
            continue
        name, status, restarts = p[0], p[2], p[3]
        if status not in ("Running", "Completed") or restarts != "0":
            findings.append(f"{name}: {status}, restarts {' '.join(p[3:])}")
    return findings


# ---------------------------------------------------------------- analysis
def analyze(run_id, tool, on_run, other_runs, earliest):
    excl = [(e, x) for e in on_run for x in e.get("excluded", []) if x.get("tool_name") == tool]
    errors = [e for e in on_run if e.get("level") in ("WARNING", "ERROR") or "exception" in e or "error" in e]
    r = {"tool": tool, "run_id": run_id, "earliest_log": earliest, "excl": excl, "errors": errors,
         "other_runs": other_runs, "run_events": len(on_run), "hypotheses": [], "gaps": []}
    if excl:
        e, x = excl[0]
        known = REASONS.get(x.get("reason"))
        r.update(verdict="Planning defect", confidence="High", priority="Medium",
                 cause=f"wb-orchestrator excluded {tool} {x.get('tool_version')} during planning: verdict {x.get('verdict')}, "
                       f"reason {x.get('reason')} - \"{x.get('detail')}\".",
                 meaning=known[0] if known else "see reason/detail above",
                 owner=known[1] if known else "Platform (wb-orchestrator) - reason not yet in the known-reasons table",
                 action=known[2] if known else "Review the reason and axes with the platform team; add this reason to REASONS once diagnosed.")
    elif errors:
        r.update(verdict="Execution defect", confidence="Medium", priority="Medium",
                 cause=f"No planning exclusion for {tool} was logged, but {len(errors)} error/warning event(s) exist for this run "
                       f"(first: {errors[0].get('logger')} {errors[0].get('message')}).",
                 owner="Unknown - needs triage", action="Inspect the error events below and the owning service's logs around their timestamps.")
    else:
        r.update(verdict="Insufficient evidence", confidence="Low", priority="Low",
                 cause=(f"No log line for this run mentions {tool}." if on_run else "No log line for this run was found.") +
                       " The cause cannot be determined from QA EKS logs.",
                 owner="Unknown", action="Re-run and collect logs immediately after the run, or retrieve archived logs (CloudWatch/S3).")
        if on_run:
            r["hypotheses"].append(f"{tool} may never have been in the candidate set (catalog or trigger configuration), "
                                   "since no planning event for it exists. Unverified.")
        r["gaps"].append("Orchestrator planning events for this run are absent." if on_run else "No logs for this run in the retained window.")
    if earliest:
        r["gaps"].append(f"Earliest log still available on the cluster: {earliest}. Older runs cannot be analyzed from kubectl.")
    if other_runs:
        x = other_runs[0]["excluded"][0]
        r["hypotheses"].append(f"A DIFFERENT run ({other_runs[0].get('run_id')}) shows {tool} excluded with reason {x.get('reason')} "
                               "- a pattern worth checking for this run, not a finding.")
    return r


def llm_summary(model, r):
    facts = {k: r[k] for k in ("tool", "run_id", "verdict", "confidence", "cause", "owner")}
    prompt = ("Write a 2-3 sentence plain-English summary of this QA finding for an engineering lead. Use only these facts, "
              "add nothing, no headings, no lists.\n" + json.dumps(facts) + " /no_think")
    body = {"model": model, "stream": False, "think": False, "options": {"temperature": 0.1, "num_ctx": 2048, "num_predict": 160},
            "messages": [{"role": "user", "content": prompt}]}
    try:
        req = urllib.request.Request("http://localhost:11434/api/chat", json.dumps(body).encode(), {"Content-Type": "application/json"})
        text = json.load(urllib.request.urlopen(req, timeout=600))["message"]["content"].strip()
    except Exception:
        return None
    bad = ("We are given", "Steps", "Let me", "Okay,", "<think>", "\n-", "\n1.")
    # the summary may only restate the facts: no advice, no echo of the prompt wording, no claims about who is responsible
    advice = ("fix", "recommend", "should", "engineering lead", "pin ", "re-run", "rerun", "unknown who", "incorrect", "mistake")
    if not text or len(text) > 700 or any(b in text for b in bad) or any(w in text.lower() for w in advice):
        return None
    return text


# ---------------------------------------------------------------- report
def render(r, facts, summary):
    short = r["run_id"].split("-")[0]
    L = [f"# {r['tool']} - Not Triggered (Run {short})",
         f"**Verdict:** {r['verdict']}   **Priority:** {r['priority']}   **Confidence:** {r['confidence']}", "",
         "## 1. Summary", summary or r["cause"], "",
         "## 2. Run Metadata", f"- Run ID: {r['run_id']}", f"- Tool: {r['tool']}"]
    if r["excl"]:
        L.append(f"- Tool catalog version: {r['excl'][0][1].get('tool_version')}")
    tenant = next((e.get("tenant_id") for e in ([x[0] for x in r["excl"]] + r["other_runs"]) if e.get("tenant_id")), None)
    if r["run_events"]:
        tenant = tenant or "see log events"
    L += [f"- Tenant: {tenant or 'not found in logs'}", "- Report facts supplied:"] + [f"    {ln}" for ln in facts.strip().splitlines()]
    L += ["", "## 3. Evidence from QA EKS"]
    if r["excl"]:
        for e, x in r["excl"][:1]:
            L.append(f"- `{e.get('timestamp')}` `{e.get('logger')}` `{e.get('message')}` ({e.get('service')})")
            L.append(f"    - {x.get('tool_name')} {x.get('tool_version')}: {x.get('verdict')} / {x.get('reason')}")
            L.append(f"    - detail: {x.get('detail')}")
            for a in x.get("axes", []):
                if a.get("verdict") != "COMPATIBLE":
                    L.append(f"    - axis {a.get('axis')}: {a.get('verdict')} - {a.get('detail')}")
            if x.get("remediation"):
                L.append(f"    - platform remediation hint: {json.dumps(x['remediation'])}")
    for e in r["errors"][:5]:
        L.append(f"- `{e.get('timestamp')}` `{e.get('logger')}` `{e.get('message')}` ({e.get('service')}) level {e.get('level')}")
    if not r["excl"] and not r["errors"]:
        L.append(f"- No decisive events for this run ({r['run_events']} routine event(s) found).")
    if r["pods"]:
        L += ["- Pod health: " + "; ".join(r["pods"])]
    else:
        L += ["- Pod health: all pods Running with 0 restarts."]
    L += ["", "## 4. Root Cause", r["cause"] + (f" Meaning: {r['meaning']}." if r.get("meaning") else ""), "",
          "## 5. Hypotheses (unverified)"] + ([f"- {h}" for h in r["hypotheses"]] or ["None"]) + [
          "", "## 6. Recommended Fix", f"- **Owner:** {r['owner']}", f"- **Action:** {r['action']}", "",
          "## 7. QA Acceptance Criteria",
          f"- On re-run, a worker task is created for {r['tool']} (no `compatibility_excluded` event for it).",
          f"- S3 receives a valid {r['tool']} output JSON for the run.",
          "- The taxonomy gate metric for this tool changes from FAIL to PASS/EVALUATED.", "",
          "## 8. Gaps"] + ([f"- {g}" for g in r["gaps"]] or ["None"])
    return "\n".join(L) + "\n"


def build_pdf(r, facts, summary, path, model=None):
    """One 'Analysis Report' PDF per not-triggered tool, from the same facts as the Markdown report."""
    import datetime
    from reportlab.lib import colors
    from reportlab.lib.colors import HexColor
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas
    from reportlab.platypus import (HRFlowable, KeepTogether, ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer, Table,
                                    TableStyle)

    NAVY, ACCENT, INK, MUTED = HexColor("#12263f"), HexColor("#d96a1b"), HexColor("#1b2330"), HexColor("#5a6577")
    LINE, PANEL = HexColor("#dde2ea"), HexColor("#f4f6f9")
    RED, AMBER, GREEN, GREY = HexColor("#b3261e"), HexColor("#a15c00"), HexColor("#1f7a4d"), HexColor("#5a6577")
    W = 174 * mm

    def st(name, **kw):
        base = dict(fontName="Helvetica", fontSize=9.5, leading=13.5, textColor=INK)
        base.update(kw)
        return ParagraphStyle(name, **base)

    body, small = st("body"), st("small", fontSize=8, leading=10.5, textColor=MUTED)
    label = st("label", fontName="Helvetica-Bold", fontSize=7.5, leading=10, textColor=MUTED)
    mono = st("mono", fontName="Courier", fontSize=8, leading=10.5)
    h2 = st("h2", fontName="Helvetica-Bold", fontSize=11.5, leading=14, textColor=NAVY, spaceBefore=14, spaceAfter=2, keepWithNext=1)
    P = lambda t, s=body: Paragraph(escape(str(t)), s)
    PX = lambda t, s=body: Paragraph(t, s)          # already-escaped markup
    short = r["run_id"].split("-")[0]
    tenant = next((e.get("tenant_id") for e in ([x[0] for x in r["excl"]] + r["other_runs"]) if e.get("tenant_id")), None)
    vcol = {"Planning defect": RED, "Execution defect": AMBER, "Environment defect": AMBER, "Repo issue": AMBER}.get(r["verdict"], GREY)
    pcol = {"High": RED, "Medium": AMBER}.get(r["priority"], GREY)
    ccol = {"High": GREEN, "Medium": AMBER}.get(r["confidence"], GREY)

    def heading(num, text):
        return [PX(f'<font color="#d96a1b">{num}</font>&nbsp;&nbsp;{escape(text)}', h2), HRFlowable(width="100%", thickness=0.6, color=LINE, spaceAfter=5)]

    def callout(flow, bar=ACCENT, bg=PANEL):
        t = Table([[flow]], colWidths=[W])
        t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), bg), ("LINEBEFORE", (0, 0), (0, -1), 3.5, bar),
                               ("LEFTPADDING", (0, 0), (-1, -1), 11), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                               ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
        return t

    def kv(rows, lw=34 * mm, mono_values=False):
        t = Table([[P(k.upper(), label), P(v, mono if mono_values else body)] for k, v in rows], colWidths=[lw, W - lw])
        t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -2), 0.4, LINE),
                               ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5), ("LEFTPADDING", (0, 0), (-1, -1), 2)]))
        return t

    def bullets(items, style=body):
        return ListFlowable([ListItem(P(i, style), leftIndent=12) for i in items], bulletType="bullet", start="•", leftIndent=12,
                            bulletFontSize=9, bulletColor=ACCENT)

    # ---- banner
    banner = Table([[PX('<font color="#f0913f">WHITEBOX  ·  TOOL TRIGGER ANALYSIS</font>', st("b0", fontName="Helvetica-Bold", fontSize=8, leading=10))],
                    [PX('<font color="white">Analysis Report</font>', st("b1", fontName="Helvetica-Bold", fontSize=22, leading=26))],
                    [PX(f'<font color="white">{escape(r["tool"])}</font><font color="#9fb3c8">  —  tool not triggered</font>', st("b2", fontSize=13, leading=17))],
                    [PX(f'<font color="#9fb3c8">QA EKS · {NS} · generated {datetime.datetime.now():%d %b %Y, %H:%M}</font>', st("b3", fontSize=8, leading=11))]],
                   colWidths=[W])
    banner.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), NAVY), ("LINEBEFORE", (0, 0), (0, -1), 6, ACCENT),
                                ("LEFTPADDING", (0, 0), (-1, -1), 16), ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                                ("TOPPADDING", (0, 0), (-1, 0), 12), ("BOTTOMPADDING", (0, -1), (-1, -1), 12)]))

    # ---- verdict cards
    def card(title, value, col):
        return [P(title.upper(), label), PX(f'<font color="{col.hexval().replace("0x", "#")}"><b>{escape(value)}</b></font>', st("v", fontSize=13, leading=17))]
    cards = Table([[card("Verdict", r["verdict"], vcol), card("Priority", r["priority"], pcol), card("Confidence", r["confidence"], ccol)]],
                  colWidths=[W * 0.44, W * 0.28, W * 0.28])
    cards.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), PANEL), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                               ("LINEABOVE", (0, 0), (0, 0), 3, vcol), ("LINEABOVE", (1, 0), (1, 0), 3, pcol), ("LINEABOVE", (2, 0), (2, 0), 3, ccol),
                               ("INNERGRID", (0, 0), (-1, -1), 5, colors.white), ("BOX", (0, 0), (-1, -1), 0, colors.white),
                               ("LEFTPADDING", (0, 0), (-1, -1), 10), ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 9)]))

    S = [banner, Spacer(1, 9), cards]
    S += heading("1", "Executive summary") + [callout(P(summary or r["cause"]))]

    S += heading("2", "Run details") + [kv([
        ("Run ID", r["run_id"]), ("Tool", r["tool"] + (f" {r['excl'][0][1].get('tool_version')}" if r["excl"] else "")),
        ("Tenant", tenant or "not found in logs"), ("Namespace", NS),
        ("Analysis", "Rule-based extraction from QA EKS logs" + (f" + summary by {model}" if summary and model else ""))], mono_values=False)]
    if facts.strip() and facts.strip() != "(none provided)":
        S += [Spacer(1, 4), P("REPORT FACTS SUPPLIED", label), Spacer(1, 2), callout([P(ln, mono) for ln in facts.strip().splitlines()], bar=LINE)]

    S += heading("3", "Evidence from QA EKS")
    for e, x in r["excl"][:1]:
        hdr = Table([[P("TIME (UTC)", label), P("SERVICE", label), P("EVENT", label)],
                     [P(str(e.get("timestamp", ""))[:19].replace("T", " "), mono), P(e.get("service", ""), mono), P(f"{e.get('logger')}: {e.get('message')}", mono)]],
                    colWidths=[34 * mm, 48 * mm, W - 82 * mm])
        hdr.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), PANEL), ("LINEBELOW", (0, 0), (-1, 0), 0.6, LINE), ("BOX", (0, 0), (-1, -1), 0.6, LINE),
                                 ("VALIGN", (0, 0), (-1, -1), 'TOP'), ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
        rows = [("Tool", f"{x.get('tool_name')} {x.get('tool_version')}"), ("Verdict", x.get("verdict")), ("Reason", x.get("reason")), ("Detail", x.get("detail"))]
        rows += [("Failed axis", f"{a.get('axis')}: {a.get('verdict')} - {a.get('detail')}") for a in x.get("axes", []) if a.get("verdict") != "COMPATIBLE"]
        if x.get("remediation"):
            rows.append(("Platform hint", json.dumps(x["remediation"])))
        S += [hdr, Spacer(1, 4), kv(rows, lw=38 * mm)]
    if r["errors"]:
        S += [Spacer(1, 4), bullets([f"{e.get('timestamp')}  {e.get('logger')}  {e.get('message')}  ({e.get('service')})  level {e.get('level')}" for e in r["errors"][:5]], mono)]
    if not r["excl"] and not r["errors"]:
        S += [callout(P(f"No decisive events for this run ({r['run_events']} routine event(s) found)."), bar=GREY)]
    pods = "; ".join(r["pods"]) if r["pods"] else "All pods Running with 0 restarts."
    S += [Spacer(1, 5), P(f"POD HEALTH", label), P(pods)]

    S += heading("4", "Root cause") + [callout(P(r["cause"]), bar=vcol)]
    if r.get("meaning"):
        S += [Spacer(1, 4), P(f"What this means: {r['meaning']}.")]

    S += heading("5", "Hypotheses (unverified)") + [bullets(r["hypotheses"]) if r["hypotheses"] else P("None.")]

    S += heading("6", "Recommended fix") + [kv([("Owner", r["owner"]), ("Action", r["action"])], lw=24 * mm)]

    chk = [f"On re-run, a worker task is created for {r['tool']} (no compatibility_excluded event for it).",
           f"S3 receives a valid {r['tool']} output JSON for the run.",
           "The taxonomy gate metric for this tool changes from FAIL to PASS / EVALUATED."]
    ck = Table([[P("o", st("cb", fontName="ZapfDingbats", fontSize=10, textColor=ACCENT)), P(c)] for c in chk], colWidths=[7 * mm, W - 7 * mm])
    ck.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3), ("LEFTPADDING", (0, 0), (-1, -1), 2)]))
    S += [KeepTogether(heading("7", "QA acceptance criteria") + [ck])]

    S += heading("8", "Gaps and limits") + [bullets(r["gaps"]) if r["gaps"] else P("None.")]

    footer_left = f"Whitebox tool-trigger analysis  ·  {r['tool']}  ·  run {short}"

    class Numbered(canvas.Canvas):
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            self._pages = []

        def showPage(self):
            self._pages.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._pages)
            for state in self._pages:
                self.__dict__.update(state)
                self.setStrokeColor(LINE)
                self.setLineWidth(0.6)
                self.line(18 * mm, 15 * mm, 192 * mm, 15 * mm)
                self.setFont("Helvetica", 7.5)
                self.setFillColor(MUTED)
                self.drawString(18 * mm, 10.5 * mm, footer_left)
                self.drawRightString(192 * mm, 10.5 * mm, f"Page {self._pageNumber} of {total}")
                super().showPage()
            super().save()

    SimpleDocTemplate(str(path), pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=14 * mm, bottomMargin=20 * mm,
                      title=f"Analysis Report - {r['tool']} - {short}", author="Whitebox QA analysis").build(S, canvasmaker=Numbered)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--tool", required=True, help="one tool, or several separated by commas: crosshair,pymcdc")
    ap.add_argument("--facts", default="")
    ap.add_argument("--since", default="72h")
    ap.add_argument("--model", default="qa-eks-mentor-trained")
    ap.add_argument("--no-llm", action="store_true")
    a = ap.parse_args()
    facts = pathlib.Path(a.facts).read_text(encoding="utf-8") if a.facts else "(none provided)"
    probe = subprocess.run(["kubectl", "get", "pods", "-n", NS, "--no-headers"], capture_output=True, text=True)
    if probe.returncode != 0:
        raise SystemExit("Cannot reach QA EKS (SSO expired?). Run: aws sso login --profile qa-eks-ro --no-browser\n" + probe.stderr[-300:])
    out = pathlib.Path(__file__).parent / "reports"
    out.mkdir(exist_ok=True)
    pods = pod_findings()
    for tool in [t.strip() for t in a.tool.split(",") if t.strip()]:
        on_run, other_runs, earliest = collect(a.run_id, tool, a.since)
        res = analyze(a.run_id, tool, on_run, other_runs, earliest)
        res["pods"] = pods
        summary = None if a.no_llm else llm_summary(a.model, res)
        stem = f"{tool}-{a.run_id.split('-')[0]}"
        (out / f"{stem}.md").write_text(render(res, facts, summary), encoding="utf-8")
        pdf = out / f"Analysis_Report_{stem}.pdf"
        build_pdf(res, facts, summary, pdf, a.model)
        print(pdf, "| summary by model" if summary else "| summary from rules")
