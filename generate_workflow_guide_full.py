"""Builds Workflow_Guide_Full_Implementation.pdf: everything implemented in the automation, with flow charts.
Run:  python generate_workflow_guide_full.py
"""
import re
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.pdfgen import canvas
from reportlab.platypus import Flowable, HRFlowable, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

OUT = "Workflow_Guide_Full_Implementation.pdf"
NAVY, BLUE, TEAL = colors.HexColor("#0F172A"), colors.HexColor("#1E3A8A"), colors.HexColor("#0D9488")
GRAY, LIGHT, CARD = colors.HexColor("#475569"), colors.HexColor("#F8FAFC"), colors.HexColor("#F1F5F9")
BORDER = colors.HexColor("#CBD5E1")
C = {  # box fills
    "blue": (colors.HexColor("#DBEAFE"), colors.HexColor("#2563EB")),
    "teal": (colors.HexColor("#CCFBF1"), colors.HexColor("#0D9488")),
    "amber": (colors.HexColor("#FEF3C7"), colors.HexColor("#D97706")),
    "red": (colors.HexColor("#FEE2E2"), colors.HexColor("#DC2626")),
    "green": (colors.HexColor("#DCFCE7"), colors.HexColor("#16A34A")),
    "gray": (colors.HexColor("#F1F5F9"), colors.HexColor("#64748B")),
    "violet": (colors.HexColor("#EDE9FE"), colors.HexColor("#7C3AED")),
}


class Chart(Flowable):
    """A small flow chart. nodes: id -> (x, y, w, h, text, color, shape); edges: (from, to, label, via)
    Coordinates are from the bottom-left of the chart area; shape 'box' | 'dec' | 'round'."""

    def __init__(self, width, height, nodes, edges):
        super().__init__()
        self.width, self.height, self.nodes, self.edges = width, height, nodes, edges

    def wrap(self, aw, ah):
        return self.width, self.height

    def _anchor(self, n, side):
        x, y, w, h = n[:4]
        return {"t": (x + w / 2, y + h), "b": (x + w / 2, y), "l": (x, y + h / 2), "r": (x + w, y + h / 2)}[side]

    def _arrow(self, p, q, label, via):
        c = self.canv
        c.setStrokeColor(GRAY); c.setFillColor(GRAY); c.setLineWidth(1)
        pts = [p] + (via or []) + [q]
        path = c.beginPath(); path.moveTo(*pts[0])
        for pt in pts[1:]:
            path.lineTo(*pt)
        c.drawPath(path, stroke=1, fill=0)
        (x1, y1), (x2, y2) = pts[-2], pts[-1]
        dx, dy = x2 - x1, y2 - y1; L = max((dx * dx + dy * dy) ** 0.5, 0.01); ux, uy = dx / L, dy / L
        a = c.beginPath(); a.moveTo(x2, y2)
        a.lineTo(x2 - 6 * ux + 3 * uy, y2 - 6 * uy - 3 * ux); a.lineTo(x2 - 6 * ux - 3 * uy, y2 - 6 * uy + 3 * ux); a.close()
        c.drawPath(a, stroke=0, fill=1)
        if label:
            mx, my = (pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2
            c.setFont("Helvetica-Bold", 7); c.setFillColor(BLUE); c.drawCentredString(mx + (0 if abs(pts[0][1] - pts[1][1]) < 1 else 8), my + 3, label)

    def draw(self):
        c = self.canv
        for a, b, label, via, sa, sb in [(e + (None,) * 6)[:6] for e in self.edges]:
            self._arrow(self._anchor(self.nodes[a], sa or "b"), self._anchor(self.nodes[b], sb or "t"), label, via)
        for x, y, w, h, text, col, shape in self.nodes.values():
            fill, line = C[col]
            c.setFillColor(fill); c.setStrokeColor(line); c.setLineWidth(1.2)
            if shape == "dec":
                p = c.beginPath(); p.moveTo(x + w / 2, y + h); p.lineTo(x + w, y + h / 2); p.lineTo(x + w / 2, y); p.lineTo(x, y + h / 2); p.close()
                c.drawPath(p, stroke=1, fill=1)
            elif shape == "round":
                c.roundRect(x, y, w, h, h / 2.2, stroke=1, fill=1)
            else:
                c.roundRect(x, y, w, h, 4, stroke=1, fill=1)
            c.setFillColor(NAVY); c.setFont("Helvetica", 7.4)
            lines = text.split("\n"); ty = y + h / 2 + (len(lines) - 1) * 4.2 - 2.6
            for i, ln in enumerate(lines):
                c.drawCentredString(x + w / 2, ty - i * 8.4, ln)


def N(x, y, w, h, text, col="blue", shape="box"):
    return (x, y, w, h, text, col, shape)


def build():
    ss = getSampleStyleSheet()
    body = ParagraphStyle("b", parent=ss["Normal"], fontName="Helvetica", fontSize=9.2, leading=13, textColor=NAVY, spaceAfter=5)
    small = ParagraphStyle("s", parent=body, fontSize=8, leading=11, textColor=GRAY)
    h1 = ParagraphStyle("h1", parent=body, fontName="Helvetica-Bold", fontSize=15, leading=19, textColor=BLUE, spaceBefore=4, spaceAfter=6)
    h2 = ParagraphStyle("h2", parent=body, fontName="Helvetica-Bold", fontSize=10.5, leading=14, textColor=TEAL, spaceBefore=8, spaceAfter=3)
    title = ParagraphStyle("t", parent=body, fontName="Helvetica-Bold", fontSize=26, leading=31, textColor=NAVY)
    cell = ParagraphStyle("c", parent=body, fontSize=8, leading=10.5, spaceAfter=0)
    cellb = ParagraphStyle("cb", parent=cell, fontName="Helvetica-Bold", textColor=colors.white)

    def tbl(rows, widths, head=True):
        esc = lambda x: re.sub(r'<(?!/?(br|b|font)(?![a-z]))', '&lt;', str(x))
        data = [[Paragraph(esc(x), cellb if (head and i == 0) else cell) for x in r] for i, r in enumerate(rows)]
        t = Table(data, colWidths=widths, repeatRows=1 if head else 0)
        st = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("GRID", (0, 0), (-1, -1), 0.4, BORDER), ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]
        if head:
            st += [("BACKGROUND", (0, 0), (-1, 0), BLUE)]
        st += [("BACKGROUND", (0, i), (-1, i), CARD) for i in range(2, len(rows), 2)]
        t.setStyle(TableStyle(st)); return t

    s = []
    # ---------------- cover
    s += [Spacer(1, 70), Paragraph("TESTABLE WHITEBOX AUTOMATION", ParagraphStyle("k", parent=small, fontName="Helvetica-Bold", textColor=TEAL, fontSize=10)),
          Paragraph("Full Workflow Guide", title), Paragraph("Everything implemented, with flow charts", ParagraphStyle("st", parent=body, fontSize=13, textColor=GRAY)),
          Spacer(1, 10), HRFlowable(width="100%", color=TEAL, thickness=2), Spacer(1, 12)]
    s.append(Paragraph(
        "This guide explains the whole automation in one place: how a test run works, what happens after it (S3 evidence, bug drafts, SharePoint, Teams), "
        "how the QA EKS live log capture explains platform defects by rules, how a folder of tool results is validated, and how to process a run <b>without executing it again</b>. "
        "Each part starts with a flow chart, followed by the details.", body))
    s.append(Paragraph("<b>Branch:</b> dev &nbsp;&nbsp; <b>Latest commit:</b> af4944b+ &nbsp;&nbsp; <b>Date:</b> 3 Nov 2026", small))
    s.append(Spacer(1, 10))
    s.append(tbl([["#", "Part", "What it covers"],
                  ["1", "Big picture", "All stages from queue to Teams in one chart; what was implemented"],
                  ["2", "The test run", "Steps 0 to 15 in the browser; pre-flight check; where the live EKS collector starts and stops"],
                  ["3", "Post-processing", "eks fetch, S3 check, history, SharePoint, Teams; S3 failure, dry run, no duplicates"],
                  ["4", "QA EKS root cause", "Live capture, known patterns (rules), what is written when no rule matches"],
                  ["5", "Validate a folder", "npm run validate: a folder of tool results, PDF report"],
                  ["6", "A run without execution", "Process a finished run from its run id"],
                  ["7", "Automatic and manual", "Which tasks the script does itself and which a person must do"],
                  ["8", "Reference", "Commands, settings, files produced, what is proven and what is not"]],
                 [24, 130, 378]))
    s.append(PageBreak())

    # ---------------- 1 big picture
    s += [Paragraph("1. The big picture", h1)]
    nodes = {
        "q": N(10, 262, 100, 34, "builds.json / queue\nbranches to test", "gray", "round"),
        "r": N(135, 262, 110, 34, "Browser test run\n(Playwright, steps 0-15)", "blue"),
        "c": N(270, 262, 120, 34, "Live QA EKS collector\n(read only, steps 11-12)", "violet"),
        "w": N(415, 262, 105, 34, "Background worker\n(next branch starts)", "gray"),
        "e": N(10, 188, 120, 38, "eks step: fetch saved\neks-live from SharePoint\n(only if not on this PC)", "violet"),
        "s3": N(150, 188, 110, 38, "S3 evidence check\n(tool results, PASS/FAIL)", "teal"),
        "ok": N(280, 188, 60, 38, "S3 ok?", "amber", "dec"),
        "bug": N(385, 188, 135, 38, "Bug drafts per defective tool\n(PDF + HTML + Jira text)", "blue"),
        "ai": N(360, 114, 160, 40, "Root cause: pod logs ->\nknown patterns (rules)\n-> real lines attached", "violet"),
        "sp": N(150, 40, 130, 40, "SharePoint copy\n<day>/<branch>[_RUNn]", "green"),
        "tm": N(310, 40, 120, 40, "Teams message\n(card with results)", "green"),
        "stop": N(10, 108, 125, 52, "S3 failed: EKS logs exist?\nyes: RCA from the EKS logs\n(rules), still to SharePoint\nand Teams. no: stop", "amber"),
    }
    edges = [("q", "r", "", None, "r", "l"), ("r", "c", "", None, "r", "l"), ("c", "w", "", None, "r", "l"),
             ("w", "e", "", [(467, 245), (70, 245)], "b", "t"), ("e", "s3", "", None, "r", "l"), ("s3", "ok", "", None, "r", "l"),
             ("ok", "bug", "yes", None, "r", "l"), ("bug", "ai", "", None, "b", "t"),
             ("ai", "sp", "", [(440, 97), (215, 97)], "b", "t"), ("sp", "tm", "", None, "r", "l"),
             ("ok", "stop", "no", [(310, 134)], "b", "r")]
    s.append(Chart(530, 305, nodes, edges))
    s.append(Paragraph("Each branch is handled by the browser run first. When it finishes, a background worker does everything else, so the next branch can start at once "
                       "and the platform is not left idle. The root cause is written by rules from real log lines; only the S3 check decides pass or fail.", body))
    s += [Paragraph("What was implemented, in one line each", h2),
          tbl([["Area", "Implemented"],
               ["Test run", "Playwright flow of the platform (repo, branch, trigger, confidence engine), 60 minute limit, stuck-run early stop, date placeholders, optional dummy commit"],
               ["Evidence", "S3 check per language (Python, JS, TS, C#, Java), false-empty detection, taxonomy report with UI values"],
               ["Reports", "Bug drafts per defective tool: PDF, HTML and Jira text, with Action and Acceptance rows"],
               ["QA EKS", "Live pod and service log capture, known-pattern rules, per-tool records, stuck-run detection, history re-check"],
               ["Root cause", "Known-pattern rules over real log lines (eks-live, failure.json); NO_KNOWN_PATTERN with the real lines attached when no rule matches"],
               ["Delivery", "SharePoint copy with RUNn folders, Teams card, earlier-run history from SharePoint"],
               ["Setup", "eks:setup, sp:login, status page"],
               ["Start-up check", "npm run preflight, also the second step of npm test: AWS keys, sign-ins, cluster; OK / WARN / FAIL with effect and fix (PREFLIGHT=strict stops on a FAIL)"],
               ["Dry run", "POST_DRYRUN=1 or --dry-run: everything that only reads runs, the SharePoint copy and the Teams card are only previewed"],
               ["No duplicates", "A SharePoint folder that already holds the same run id is reused; a complete Teams card is sent once per run"],
               ["Round files", "summary.md per round, timings.xlsx per branch (steps and tool pods), warnings.log for problems that must not stop a run"],
               ["Validate a folder", "npm run validate checks a folder of tool results and writes a PDF report (checker table, tools that did not pass, rule diagnosis)"],
               ["Safety", "S3 failure without EKS logs stops SharePoint and Teams; all EKS access is read only; secrets redacted in captured logs"]],
              [80, 452])]
    s.append(PageBreak())

    # ---------------- 2 test run
    s += [Paragraph("2. The test run (steps 0 to 15)", h1),
          Paragraph("Source: <font face='Courier'>tests/merge-flow.spec.ts</font>. Steps marked critical stop the branch when they fail.", body)]
    L = [("0", "Dummy commit (only if DUMMY_PR=yes)", "gray"), ("1", "Chat Execution Assistant opens", "blue"), ("2", "New analysis / Refresh repos", "blue"),
         ("3", "Connect / Import repository", "blue"), ("4", "Choose repository", "blue"), ("5", "Choose branch", "blue"), ("6", "'On PR merge' trigger ticked", "blue"),
         ("7", "Confirm repository", "blue"), ("8", "Coverage preview screenshots", "blue"), ("9", "Continue / Review branches", "blue")]
    R = [("10", "Run plan, Execute run", "blue"), ("11", "Execution status, open Confidence Engine\nSTART live EKS collector", "violet"), ("12", "Wait for the run to finish\nSTOP collector, save eks-live", "violet"),
         ("13", "Screenshot: PR confidence score", "blue"), ("14", "Gate analysis screenshots", "blue"), ("15", "Taxonomy report + run-details.json", "blue"),
         ("end", "Hand off to the background worker", "green")]
    nodes, edges = {}, []
    for i, (n, t, col) in enumerate(L):
        nodes[f"l{i}"] = N(20, 318 - i * 31, 200, 24, f"{n}. {t}", col)
        if i: edges.append((f"l{i-1}", f"l{i}"))
    for i, (n, t, col) in enumerate(R):
        h = 30 if "\n" in t else 24
        nodes[f"r{i}"] = N(300, 318 - i * 40, 220, h, (f"{n}. " if n != "end" else "") + t, col)
        if i: edges.append((f"r{i-1}", f"r{i}"))
    edges.append(("l9", "r0", "", [(120, 8), (410, 8)], "b", "t"))
    nodes["l9"] = N(20, 318 - 9 * 31, 200, 24, "9. Continue / Review branches", "blue")
    s.append(Chart(540, 345, nodes, edges))
    s += [Paragraph("What was added around the run", h2),
          tbl([["Feature", "How it works"],
               ["Live QA EKS collector", "Starts at step 11, stops at step 12, only when EKS_AUTO=on and the cluster is reachable. Reads pod logs of this run id (kubectl, read only) and saves them in eks-live. EKS_LIVE=off turns only this off."],
               ["Stuck-run early stop", "If the collector sees a known stuck state, the wait in step 12 ends early and the failure message names the cause."],
               ["60 minute limit", "A run that does not finish within 60 minutes is stopped and reported."],
               ["Run mismatch guard", "After step 15 the run on the site must be the branch asked for; otherwise RUN-MISMATCH.txt is written."],
               ["Handoff", "POSTPROCESS=background (default): the worker does S3, SharePoint and Teams. POSTPROCESS=inline does it in the test."],
               ["Pre-flight check", "Before the first branch (second setup step of npm test, or npm run preflight): branch list, platform login, AWS keys (a real read), SharePoint sign-in, Teams webhook, EKS cluster. Prints OK / WARN / FAIL with the effect and the fix and saves preflight.json; changes nothing. PREFLIGHT=strict stops the run on a FAIL, PREFLIGHT=off skips it."],
               ["Timings", "At the end of each branch, timings.xlsx (sheets Summary, Steps, Tools, Post-processing) and timings.json in the branch folder, timings-summary.csv for the round: the time of every step and every tool pod (read only, never stops a run)."]],
              [120, 412])]
    s.append(PageBreak())

    # ---------------- 3 post-processing
    s += [Paragraph("3. Post-processing of one branch", h1),
          Paragraph("Source: <font face='Courier'>utils/postprocess.ts</font>. Runs in the worker after a test, or by hand with <font face='Courier'>npm run post</font>. "
                    "Network problems are retried after 30 s, 90 s and 3 min.", body)]
    nodes = {
        "a": N(190, 300, 150, 28, "npm run post / worker starts", "gray", "round"),
        "b": N(165, 250, 200, 32, "eks: eks-live already on this PC?", "amber", "dec"),
        "b2": N(400, 252, 125, 30, "Download eks-live from\nSharePoint (same run id)", "violet"),
        "c": N(190, 200, 150, 30, "s3: check tool evidence", "teal"),
        "d": N(190, 150, 150, 30, "history: earlier run from SharePoint", "teal"),
        "e": N(165, 100, 200, 34, "S3 step failed?", "amber", "dec"),
        "f": N(5, 92, 140, 50, "rca: EKS logs of this run exist?\nyes: root causes from the EKS\nlogs only (rules), then go on\nno: skip SharePoint and Teams", "violet"),
        "g": N(190, 50, 150, 30, "sharepoint: copy branch folder", "green"),
        "h": N(190, 6, 150, 30, "teams: send the card", "green"),
    }
    edges = [("a", "b"), ("b", "c", "yes", None, "b", "t"), ("b", "b2", "no", None, "r", "l"), ("b2", "c", "", [(462, 215)], "b", "r"),
             ("c", "d"), ("d", "e"), ("e", "g", "no", None, "b", "t"), ("e", "f", "yes", None, "l", "r"), ("g", "h")]
    s.append(Chart(540, 335, nodes, edges))
    s += [Paragraph("Steps and results", h2),
          tbl([["Step", "What it does", "Result written to postprocess.json"],
               ["eks", "Finds <day>/<branch>[_RUNn]/eks-live on the team SharePoint folder whose summary.json has this run id and downloads it (read only). Skipped when local, no sp:login, or none exists.", "done / skipped"],
               ["s3", "Reads the run's evidence from S3 (cells/cell-001/qa/cell-001/...), judges each tool PASS / EMPTY / FAIL / N/A, writes s3-check.json, builds bug drafts and the QA EKS reports.", "done / failed (for example expired AWS keys)"],
               ["history", "Reads the earlier run of this branch from SharePoint for the Tool Trigger Log.", "done / none found"],
               ["rca", "Only when s3 failed: root causes from the EKS logs alone for FAILED pods and for tools the orchestrator rejected or blocked; written to eks-rca/.", "done / skipped"],
               ["sharepoint", "Uploads the branch folder to <day>/<branch>; if it exists, to _RUN2, _RUN3 and so on.", "done / skipped"],
               ["teams", "Sends a card with tool results and an Open-the-run button.", "done / skipped"]],
              [58, 330, 144]),
          Paragraph("Lesson from the Java run: when S3 failed with ExpiredToken, the old flow still posted SharePoint and Teams with no tool data. Now a failed S3 step "
                    "writes the root causes from the run's live EKS logs (step rca, folder eks-rca: known patterns, by rules) and sends SharePoint and Teams with them; "
                    "the Teams card says S3 was not available. Without an eks-live of that run, both are skipped.", small),
          Paragraph("More behaviour of the worker", h2),
          tbl([["Feature", "How it works"],
               ["Dry run", "POST_DRYRUN=1 in .env, or npm run post -- \"&lt;folder&gt;\" --dry-run: S3, EKS logs and bug drafts run as usual; the SharePoint upload (files, MB, folder) and the Teams card (text, buttons, size against the 28 KB webhook limit) are only printed and saved in &lt;round&gt;/dryrun/. Use it to test a new .env without filling the channel."],
               ["No duplicate folders", "A SharePoint folder of the same day that already holds the same run_id in its run-details.json is reused instead of making _RUN2, _RUN3."],
               ["No duplicate cards", "A complete Teams card (with the S3 result) is sent once per run (teams-sent.json); TEAMS_RESEND=1 sends it again. A partial card (S3 failed) is replaced by the full one."],
               ["Stale S3 result", "When S3 fails now, an older s3-check.json of that folder is kept as s3-check.previous.json, so a card never shows old tool results."],
               ["warnings.log, summary.md", "Problems that must not stop a run go to warnings.log in the branch folder; &lt;round&gt;/summary.md has one row per branch and is rebuilt after every branch."]],
              [120, 412])]
    s.append(PageBreak())

    # ---------------- 4 EKS root cause by rules
    s += [Paragraph("4. QA EKS logs and the root cause (rules)", h1),
          Paragraph("Goal: for every defective tool, name the platform cause from real log lines, by rules (known patterns). No model is involved: nothing is guessed, and when no rule matches the real lines are attached for a person to read.", body)]
    nodes = {
        "t": N(190, 236, 150, 26, "Defective tool (FAIL / EMPTY)", "gray", "round"),
        "ev": N(150, 184, 230, 40, "Gather evidence: eks-live pod logs, service\nlines naming this tool, failure.json from S3", "violet"),
        "no": N(10, 188, 105, 34, "No real log lines:\nnothing is written", "red"),
        "kp": N(190, 124, 150, 40, "Known pattern matches?", "amber", "dec"),
        "pa": N(380, 124, 140, 40, "Answer from the rule,\nthe real line quoted", "green"),
        "nk": N(190, 64, 150, 40, "NO_KNOWN_PATTERN: the real\nlines are attached", "gray"),
        "out": N(190, 8, 150, 38, "Bug draft: PDF + Jira text,\nSharePoint upload", "green"),
    }
    edges = [("t", "ev"), ("ev", "no", "none", None, "l", "r"), ("ev", "kp"), ("kp", "pa", "yes", None, "r", "l"), ("kp", "nk", "no"), ("nk", "out"), ("pa", "out", "", [(450, 27)], "b", "r")]
    s.append(Chart(540, 270, nodes, edges))
    s += [Paragraph("Components", h2),
          tbl([["File", "Role"],
               ["utils/eksCollector.ts", "Live capture of pod and service logs of this run id; redacts secrets; writes eks-live (pods/, tools/, services.log, summary.json, run_summary.md)."],
               ["utils/eksReport.ts", "Per-tool status records: PASSED, FAILED, EMPTY_OUTPUT, NEVER_DISPATCHED, STUCK_WAITING, UNKNOWN."],
               ["utils/eksPatterns.ts", "The known-pattern rules (table below) and stuck-run detection."],
               ["utils/eksDiagnose.ts", "Collects the evidence of one tool: its failure.json, the pod's exit reason and console lines, the service lines that name exactly this tool (planning lists are read for the tool's own entry); applies the patterns; otherwise returns the lines as NO_KNOWN_PATTERN."],
               ["utils/eksAnalyze.ts", "Cluster access helpers: the kubectl context qa-eks-ro, the key or profile, a reachability check."],
               ["utils/eksFetch.ts, utils/eksOnlyRca.ts", "The eks step (download a run's saved eks-live from SharePoint) and the root causes written when the S3 check failed."],
               ["utils/eksHistory.ts, eksSetup.ts, eksLogin.ts", "npm run eks:history (re-check a finished run), npm run eks:setup (kubectl, AWS sign-in, allowed IP), the browser sign-in."]],
              [150, 382]),
          Paragraph("Known patterns (utils/eksPatterns.ts)", h2),
          tbl([["Pattern id", "What the log says", "Owner named in the report"],
               ["workspace-permission-denied", "failure.json or console: Permission denied (Errno 13) under /workspaces/...", "Platform (workspace permissions of the runner)"],
               ["cell-cpu-capacity", "dispatch.admission_rejected_task with reason CELL_CPU_CAPACITY", "Platform (cell CPU capacity / admission)"],
               ["runtime-unavailable-unplaceable", "planning.tools_unplaceable lists the tool with reason EXECUTION_RUNTIME_UNAVAILABLE and a detail", "Platform (orchestrator planning / runtime availability)"],
               ["tool-readiness-blocked", "worker.tool_readiness_blocked_execution for the tool (readiness_status, skip_reason such as MISSING_BINARY)", "Platform (worker startup check / tool installation)"],
               ["planning-skipped-startup-readiness", "planning.tools_skipped_startup_readiness lists the tool in skipped_tools", "Platform (orchestrator planning / startup readiness)"],
               ["ran-but-excluded", "the checker says the tool ran although the matrix of this version excludes it", "Platform (planning / compatibility matrix)"],
               ["pod-completed-no-output", "the tool's pod ended Completed, but S3 has no result for it", "Platform (tool runner result upload)"],
               ["oom-killed, image-pull, stuck run", "OOMKilled (exit 137), ImagePullBackOff, a run that stayed waiting for a runtime", "Platform (runner limits / image registry / runtime)"]],
              [150, 230, 152]),
          Paragraph("A rule is added in eksPatterns.ts, with a unit test, each time the team solves a new case: the next run that hits it is explained at once. Earlier versions also wrote the explanation with a local Ollama model; it was removed on 3 Nov 2026 and is in the git history up to commit af4944b.", small)]
    s.append(PageBreak())

    # ---------------- 5 validate
    s += [Paragraph("5. Validate a folder of tool results", h1),
          Paragraph("<font face='Courier'>npm run validate</font> checks a folder of tool results without a test run and without AWS keys.", body)]
    nodes = {
        "a": N(2, 30, 96, 44, "Tool folder\n<tool>/<id>/0/<file>", "gray"), "b": N(112, 30, 96, 44, "Local reader\n(serves it like S3)", "violet"),
        "c": N(222, 30, 96, 44, "Same checker as\nthe S3 step:\nPASS / EMPTY / FAIL", "teal"), "d": N(332, 30, 96, 44, "Tools that did not\npass: their file's\nnote + rule diagnosis", "blue"),
        "e": N(442, 30, 96, 44, "validation-report.pdf\n(and .md)", "green"),
    }
    edges = [("a", "b", "", None, "r", "l"), ("b", "c", "", None, "r", "l"), ("c", "d", "", None, "r", "l"), ("d", "e", "", None, "r", "l")]
    s.append(Chart(540, 90, nodes, edges))
    s += [tbl([["Question", "Answer"],
               ["How", "npm run validate -- \"&lt;tool folder&gt;\" [--repo owner/name] [--run-id id]. The folder name is the branch name: its prefix and version (PY_V36..., JV_V17...) decide the language and the tool matrix."],
               ["Output", "results/validate_&lt;time&gt;/&lt;name&gt;/validation-report.pdf: the checker's table and the tools that did not pass, with what their own file says and a rule diagnosis when the folder holds a failure.json; plus validation-report.md, s3-check.json and s3-evidence/."],
               ["Limit", "Only the tool files are known (no run id, no EKS logs): a tool that never produced a folder can only be reported as not triggered."]],
              [90, 442])]
    s.append(PageBreak())

    # ---------------- 6 without execution
    s += [Paragraph("6. Processing a run without executing it", h1),
          Paragraph("Use this when the run already happened (on this PC or another) and you have its ids. Example: the Java run JV_V17_MAVEN_THINJAR_MICRO.", body)]
    nodes = {
        "a": N(170, 280, 200, 30, "Run ids: run_id, tenant, project,\nrepository, branch, commit", "gray", "round"),
        "b": N(170, 230, 200, 30, "Create <results>/<round>/<branch>/\nrun-details.json from the ids", "blue"),
        "c": N(170, 180, 200, 30, "Check AWS keys in .env\n(QA-S3-Readonly, a few hours)", "amber"),
        "d": N(170, 130, 200, 30, "npm run post -- \"<folder>\" --repo owner/name", "teal"),
        "e": N(20, 70, 150, 40, "eks step finds and downloads\neks-live of this run id", "violet"),
        "f": N(195, 70, 150, 40, "S3 check, QA EKS reports,\nbug drafts from real pod logs", "teal"),
        "g": N(370, 70, 150, 40, "SharePoint _RUNn upload\nand Teams message", "green"),
        "h": N(170, 8, 200, 30, "Result in the branch folder and on SharePoint", "green", "round"),
    }
    edges = [("a", "b"), ("b", "c"), ("c", "d"), ("d", "e", "", [(270, 115), (95, 115)], "b", "t"), ("e", "f", "", None, "r", "l"), ("f", "g", "", None, "r", "l"),
             ("g", "h", "", [(445, 23)], "b", "r")]
    s.append(Chart(540, 320, nodes, edges))
    s += [tbl([["Question", "Answer"],
               ["Which command?", "npm run post -- \"results\\<round>\\<branch folder>\" --repo owner/name [--url run page]. The folder only needs run-details.json."],
               ["Where do EKS logs come from?", "From the eks-live folder the PC that ran the test saved on SharePoint (matched by run id). Without it the cluster service logs are used, which are weaker."],
               ["Was the live capture used for the Java run?", "Not at first: the first pass used the weaker cluster-log read. After the SharePoint eks-live was downloaded, 29 bug drafts were rebuilt from it."],
               ["What did the real logs show?", "10 tools were never started: dispatch.admission_rejected_task, reason CELL_CPU_CAPACITY (checkstyle, cpd, jacoco, java-perf-dependency, maven-checksum, maven-versions, owasp-depcheck, pitest, pmd, spotbugs). pydriller failed with Permission denied under /workspaces."],
               ["What if S3 fails?", "With the run's eks-live: root causes are written from the EKS logs alone (eks-rca/) and SharePoint and Teams still go out, the card saying S3 was not available. Without eks-live: nothing is sent. Either way, put fresh AWS keys in .env and run the same command again for the full report."],
               ["Only a folder of tool files, no run id?", "Use npm run validate (section 5): it needs neither a run id nor AWS keys, and writes a PDF."]],
              [150, 382])]
    s.append(PageBreak())

    # ---------------- 7 automatic vs manual
    s += [Paragraph("7. Automatic and manual: who does what", h1),
          Paragraph("<b>Automatic</b> = the script does it by itself once a run starts. <b>Manual</b> = a person must do it (once, when it expires, or each time).", body)]
    nodes = {
        "m1": N(10, 150, 120, 44, "MANUAL, one-time setup\nsign-ins, AWS keys, .env,\nbuilds.json", "amber"),
        "m2": N(150, 150, 110, 44, "MANUAL: start\nnpm test / queue start", "amber"),
        "a1": N(280, 150, 120, 44, "AUTOMATIC\npre-flight, browser run,\nEKS capture, guards", "green"),
        "a2": N(420, 150, 105, 44, "AUTOMATIC\nS3, drafts, root\ncauses, SharePoint, Teams", "green"),
        "m3": N(150, 60, 150, 44, "MANUAL: when something fails\nnew AWS keys, re-run npm run post", "amber"),
        "m4": N(330, 60, 190, 44, "MANUAL: judgement\nread results, file Jira bugs,\nadd rules for new cases", "amber"),
    }
    edges = [("m1", "m2", "", None, "r", "l"), ("m2", "a1", "", None, "r", "l"), ("a1", "a2", "", None, "r", "l"),
             ("a2", "m4", "", [(472, 127), (425, 127)], "b", "t"), ("a2", "m3", "", [(472, 127), (225, 127)], "b", "t")]
    s.append(Chart(540, 215, nodes, edges))
    s += [Paragraph("Automatic (the script does it)", h2),
          tbl([["Area", "What the script does by itself", "Condition"],
               ["Browser run", "Steps 0 to 15: open chat, choose repo and branch, execute, wait, screenshots, gate analysis, taxonomy report, run-details.json", "Saved platform sign-in is valid"],
               ["Dummy commit", "Pushes a README comment so the branch has a new commit", "DUMMY_PR=yes"],
               ["Live EKS capture", "Starts at step 11, stops at step 12, saves eks-live; stuck-run early stop; 60 minute limit; run-mismatch guard", "EKS_AUTO=on and cluster reachable"],
               ["Handoff", "Passes the finished branch to the background worker so the next branch starts", "POSTPROCESS=background"],
               ["eks fetch", "Downloads the run's eks-live from SharePoint when it is not on this PC", "sp:login saved; the run was captured"],
               ["S3 check", "Reads evidence, judges every tool, writes s3-check.json; retries network problems after 30 s, 90 s, 3 min", "AWS keys valid"],
               ["Bug drafts", "PDF, HTML and Jira text per defective tool, with Action and Acceptance", "BUG_REPORTS not off"],
               ["Root cause", "Known-pattern rules over the real log lines (eks-live, failure.json); the lines are attached when no rule matches", "EKS_AUTO=on"],
               ["Pre-flight check", "Reads what is missing (keys, sign-ins, cluster) and what it would skip; saves preflight.json", "Second step of npm test; PREFLIGHT not off"],
               ["Timings and summaries", "timings.xlsx per branch, summary.md per round, warnings.log; dry run when asked", "Always; POST_DRYRUN for the preview"],
               ["History", "Reads the earlier run of the branch from SharePoint", "sp:login saved"],
               ["SharePoint copy", "Uploads the branch folder; uses _RUN2, _RUN3 if the folder exists", "S3 step did not fail"],
               ["Teams card", "Sends the result card with the Open-the-run button", "TEAMS_WEBHOOK_URL set; S3 step did not fail"]],
              [80, 300, 152]),
          Paragraph("Manual (a person does it)", h2),
          tbl([["Task", "How", "How often"],
               ["Platform sign-in", "npm run setup", "Once, and when the session expires"],
               ["SharePoint sign-in", "npm run sp:login (work account)", "Once per PC, and when it expires"],
               ["AWS S3 keys", "AWS access portal, QA-S3-Readonly, copy the 3 values into .env", "Every few hours (they expire)"],
               ["EKS access", "aws sso login --profile qa-eks-ro, allowed IP; check with npm run eks:setup", "When the sign-in or IP changes"],
               ["Read the pre-flight lines", "npm run preflight: fix the FAIL lines (usually AWS keys or a sign-in) before a long run", "Before each run"],
               ["Branch list and settings", "Edit builds.json and .env (Teams webhook, EKS_AUTO, POSTPROCESS and others)", "When branches or settings change"],
               ["Start the run", "npm test, or npm run queue and the owner types start", "Each run"],
               ["Process a run not executed here", "Create run-details.json from the ids, then npm run post -- \"&lt;folder&gt;\" --repo owner/name", "Each time"],
               ["Re-run after a failed step", "Fix the cause (usually new AWS keys), run npm run post again", "When S3 or another step fails"],
               ["Read results and file bugs", "Review the PDFs and Jira text; the script writes drafts but does not create Jira tickets", "Each run"],
               ["Clean up duplicates", "Delete empty Teams cards and unwanted _RUNn folders; the script cannot delete them", "When they appear"],
               ["Add a rule for a new case", "Developer: when the team solves a new platform cause, add a rule in utils/eksPatterns.ts with a unit test; the next run that hits it is explained at once", "When a new cause is found"],
               ["Commit and push", "git add by name, commit, push to dev", "When code changes"]],
              [120, 296, 116])]
    s.append(PageBreak())

    # ---------------- 8 reference
    s += [Paragraph("8. Reference", h1), Paragraph("Commands", h2),
          tbl([["Command", "Purpose"],
               ["npm test", "Run the browser flow for the branches in builds.json"],
               ["npm run setup", "Save the platform sign-in (auth.setup.ts)"],
               ["npm run s3", "S3 evidence check only, without the browser run"],
               ["npm run post -- \"&lt;folder&gt;\"", "Post-process one finished branch again (eks, S3, SharePoint, Teams)"],
               ["npm run sp:login", "Save the SharePoint sign-in used for upload, download and history"],
               ["npm run eks:setup", "Check kubectl, AWS sign-in and IP for the QA EKS cluster"],
               ["npm run eks:history -- \"&lt;folder&gt;\"", "Re-check a finished run from what the cluster still holds (read only)"],
               ["npm run preflight", "What is missing (keys, sign-ins, cluster) and what it skips; also runs at the start of npm test"],
               ["npm run post -- \"&lt;folder&gt;\" --dry-run", "Same as post, but the SharePoint copy and the Teams card are only previewed"],
               ["npm run validate -- \"&lt;tool folder&gt;\"", "Validate a folder of tool results; validation-report.pdf (section 5)"],
               ["npm run check", "Type check and unit tests (also run by GitHub on every push)"],
               ["npm run parallel", "Run several branches in parallel"],
               ["npm run queue / npm run status", "Team queue server (another developer's) / read-only status page"]],
              [190, 342]),
          Paragraph("Settings (.env)", h2),
          tbl([["Setting", "Meaning"],
               ["EKS_AUTO=on", "QA EKS analysis and live capture on (keep on: the root causes come from the live logs)"],
               ["EKS_LIVE=off", "Turns off only the live collector"],
               ["AWS_ACCESS_KEY_ID / SECRET / SESSION_TOKEN", "QA-S3-Readonly keys for the S3 check (expire in hours)"],
               ["PREFLIGHT=strict | off", "Stop the run on a FAIL of the pre-flight check / skip the check"],
               ["POST_DRYRUN=1", "Preview the SharePoint copy and the Teams card, send nothing"],
               ["TEAMS_RESEND=1", "Send a second complete Teams card for the same run"],
               ["POSTPROCESS=background|inline", "Who does S3, SharePoint and Teams"],
               ["DUMMY_PR=yes", "Push a dummy README comment first so the branch has a new commit"],
               ["TEAMS_WEBHOOK_URL", "Teams card destination; empty means no Teams step"]],
              [190, 342]),
          Paragraph("Files in a branch folder", h2),
          tbl([["File / folder", "Content"],
               ["run-details.json", "Run, tenant, project, repository, branch and commit ids"],
               ["s3-check.json, s3-evidence/", "Tool results and the downloaded evidence files"],
               ["eks-live/", "Pod logs, services.log, tool records, run_summary.md of this run"],
               ["bugs/", "Defect_Report_*.pdf, HTML and JIRA_*.jira.md per defective tool"],
               ["postprocess.json", "State of the steps: eks, s3, rca, history, sharepoint, teams"],
               ["eks-rca/", "Root causes from the EKS logs alone, written when S3 failed"],
               ["timings.xlsx, timings.json", "Time of every step and every tool pod of the branch"],
               ["warnings.log, teams-sent.json, s3-check.previous.json", "Problems that did not stop the run; the card already sent for this run; an older S3 result kept aside"],
               ["&lt;round&gt;/summary.md, dryrun/, preflight.json", "One row per branch of the round; dry-run previews; the pre-flight result"],
               ["results/validate_&lt;time&gt;/", "Output of npm run validate: validation-report.pdf, .md, s3-check.json"]],
              [190, 342]),
          Paragraph("Proven and not proven", h2),
          tbl([["Proven", "Not proven yet"],
               ["Post-processing of the Java run from ids only, with 29 bug drafts from real pod logs.<br/>eks fetch from SharePoint: 148 files, identical to a manual download.<br/>"
                "Validation of a real tool folder to a PDF (PASS 6, FAIL 19).<br/>The whole flow on a saved Python run without any model (dry run): 8 of 10 problem tools get an exact known-pattern cause.<br/>"
                "18 unit tests; the GitHub check runs the type check and the tests on every push.",
                "A full browser run with all recent changes (pre-flight, eks fetch, timings) in one go.<br/>Live EKS capture from every PC (the cluster needs the AWS sign-in and an allowed IP).<br/>"
                "Known patterns cover only causes the team has seen; for others the real log lines are attached and a person reads them.<br/>"
                "Python tools listed in a Java run are real [Language Contamination] defects by design (the platform produced results for foreign tools)."]],
              [266, 266], head=True)]

    doc = SimpleDocTemplate(OUT, pagesize=letter, leftMargin=40, rightMargin=40, topMargin=48, bottomMargin=44, title="Testable Whitebox Automation: Full Workflow Guide")

    class Canvas(canvas.Canvas):
        def __init__(self, *a, **k):
            super().__init__(*a, **k); self._pages = []

        def showPage(self):
            self._pages.append(dict(self.__dict__)); self._startPage()

        def save(self):
            for st in self._pages:
                self.__dict__.update(st)
                if self._pageNumber > 1:
                    self.setFont("Helvetica", 8); self.setFillColor(GRAY)
                    self.drawString(40, 755, "Testable Whitebox Automation  .  Full Workflow Guide"); self.drawRightString(572, 755, "dev branch  .  af4944b+")
                    self.setStrokeColor(BORDER); self.line(40, 748, 572, 748); self.line(40, 40, 572, 40)
                    self.drawString(40, 30, "Run, post-process, explain with logs, share"); self.drawRightString(572, 30, f"Page {self._pageNumber} of {len(self._pages)}")
                canvas.Canvas.showPage(self)
            canvas.Canvas.save(self)

    doc.build(s, canvasmaker=Canvas)
    print("Generated", Path(OUT).resolve())


if __name__ == "__main__":
    build()
