import os
import shutil
from pathlib import Path
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable, PageBreak, KeepTogether
)
from reportlab.pdfgen import canvas

class WorkflowGuideCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self.draw_page_decorations(num_pages)
            canvas.Canvas.showPage(self)
        canvas.Canvas.save(self)

    def draw_page_decorations(self, page_count):
        self.saveState()
        
        # Only draw headers/footers on pages 2..N
        if self._pageNumber > 1:
            # Header
            self.setFont("Helvetica", 8)
            self.setFillColor(colors.HexColor("#475569"))
            self.drawString(40, 755, "Testable Whitebox Automation  .  Workflow Guide")
            self.drawRightString(572, 755, "merge-flow branch  .  fd4e101")
            self.setStrokeColor(colors.HexColor("#E2E8F0"))
            self.setLineWidth(0.6)
            self.line(40, 748, 572, 748)

            # Footer
            self.drawString(40, 30, "Step by step: setup once, run, read the results")
            self.drawRightString(572, 30, f"Page {self._pageNumber}")
            self.setStrokeColor(colors.HexColor("#E2E8F0"))
            self.setLineWidth(0.6)
            self.line(40, 40, 572, 40)
            
        self.restoreState()


def create_merge_flow_guide():
    pdf_filename = "Workflow_Guide_merge_flow_branch.pdf"
    doc = SimpleDocTemplate(
        pdf_filename,
        pagesize=letter,
        leftMargin=40,
        rightMargin=40,
        topMargin=44,
        bottomMargin=44
    )

    styles = getSampleStyleSheet()

    # Color Palette matching gold standard
    c_navy = colors.HexColor("#0F172A")       # Slate 900
    c_blue = colors.HexColor("#1E3A8A")       # Blue 900
    c_bright_blue = colors.HexColor("#2563EB")# Blue 600
    c_teal = colors.HexColor("#0D9488")       # Teal 600
    c_gray = colors.HexColor("#475569")       # Slate 600
    c_light_bg = colors.HexColor("#F8FAFC")   # Slate 50
    c_card_bg = colors.HexColor("#F1F5F9")    # Slate 100
    c_blue_box = colors.HexColor("#EFF6FF")   # Blue 50
    c_amber_box = colors.HexColor("#FEF3C7")  # Amber 100
    c_border = colors.HexColor("#CBD5E1")     # Slate 300
    c_border_light = colors.HexColor("#E2E8F0")

    # Typography Styles
    title_super = ParagraphStyle(
        'CoverSuper', parent=styles['Normal'],
        fontName='Helvetica-Bold', fontSize=10, leading=14, textColor=c_bright_blue, spaceAfter=8
    )
    title_main = ParagraphStyle(
        'CoverTitle', parent=styles['Heading1'],
        fontName='Helvetica-Bold', fontSize=26, leading=30, textColor=c_navy, spaceAfter=8
    )
    title_sub = ParagraphStyle(
        'CoverSub', parent=styles['Normal'],
        fontName='Helvetica', fontSize=12, leading=16, textColor=c_gray, spaceAfter=20
    )
    
    sec_num = ParagraphStyle(
        'SecNum', parent=styles['Normal'],
        fontName='Helvetica-Bold', fontSize=14, leading=16, textColor=c_bright_blue
    )
    sec_title = ParagraphStyle(
        'SecTitle', parent=styles['Heading2'],
        fontName='Helvetica-Bold', fontSize=16, leading=20, textColor=c_navy, spaceAfter=2
    )
    sec_sub = ParagraphStyle(
        'SecSub', parent=styles['Normal'],
        fontName='Helvetica', fontSize=10, leading=13, textColor=c_gray, spaceAfter=10
    )
    h3_style = ParagraphStyle(
        'H3Style', parent=styles['Heading3'],
        fontName='Helvetica-Bold', fontSize=10.5, leading=14, textColor=c_blue, spaceBefore=8, spaceAfter=4
    )
    body = ParagraphStyle(
        'Body', parent=styles['Normal'],
        fontName='Helvetica', fontSize=8.5, leading=12, textColor=c_navy
    )
    body_muted = ParagraphStyle(
        'BodyMuted', parent=styles['Normal'],
        fontName='Helvetica', fontSize=8, leading=11, textColor=c_gray
    )
    body_bold = ParagraphStyle(
        'BodyBold', parent=body, fontName='Helvetica-Bold'
    )
    code_text = ParagraphStyle(
        'CodeText', parent=styles['Normal'],
        fontName='Courier', fontSize=7.5, leading=10, textColor=colors.HexColor("#1E293B")
    )
    code_bold = ParagraphStyle(
        'CodeBold', parent=code_text, fontName='Courier-Bold'
    )
    table_head = ParagraphStyle(
        'TableHead', parent=styles['Normal'],
        fontName='Helvetica-Bold', fontSize=8, leading=11, textColor=colors.white
    )

    story = []

    # =========================================================================
    # PAGE 1: COVER PAGE
    # =========================================================================
    story.append(Spacer(1, 20))
    story.append(Paragraph("TESTABLE WHITEBOX  .  TOOL VALIDATION AUTOMATION", title_super))
    story.append(Paragraph("Workflow Guide", title_main))
    story.append(Paragraph("How the <b>merge-flow</b> branch script works, file by file,<br/>and how to run it step by step", title_sub))
    story.append(HRFlowable(width="100%", thickness=1.5, color=c_bright_blue, spaceAfter=16))

    meta_table_data = [
        [Paragraph("<b>BRANCH</b>", body_muted), Paragraph("<b>LATEST COMMIT</b>", body_muted), Paragraph("<b>WRITTEN ON</b>", body_muted), Paragraph("<b>STACK</b>", body_muted)],
        [Paragraph("<b>merge-flow</b>", body_bold), Paragraph("<code>fd4e101</code>", code_bold), Paragraph("29 Oct 2026", body), Paragraph("Playwright, TypeScript, Node 22, Python", body)]
    ]
    t_meta = Table(meta_table_data, colWidths=[100, 110, 110, 212])
    t_meta.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
    ]))
    story.append(t_meta)
    story.append(Spacer(1, 24))

    story.append(Paragraph("<b>What is inside</b>", h3_style))
    story.append(Spacer(1, 4))
    
    toc_data = [
        [
            Paragraph("<b>1  The big picture</b><br/><font color='#64748B'>what the script does in one minute</font>", body),
            Paragraph("<b>2  The pipeline</b><br/><font color='#64748B'>browser lane and background lane, side by side</font>", body)
        ],
        [
            Paragraph("<b>3  Main flow</b><br/><font color='#64748B'>the 15 steps on Testable (including early blocked exit)</font>", body),
            Paragraph("<b>4  Background worker</b><br/><font color='#64748B'>hand-off, S3 check, multi-language validation, Teams</font>", body)
        ],
        [
            Paragraph("<b>5  How to use it</b><br/><font color='#64748B'>one-time setup, daily checklist, dual-account parallel</font>", body),
            Paragraph("<b>6  File map</b><br/><font color='#64748B'>which file does which job (pages, tests, utils)</font>", body)
        ],
        [
            Paragraph("<b>7  .env reference</b><br/><font color='#64748B'>every setting, what to put, defaults</font>", body),
            Paragraph("<b>8  Result folders</b><br/><font color='#64748B'>what each output file is (HTML, JSON, evidence)</font>", body)
        ],
        [
            Paragraph("<b>9  Troubleshooting</b><br/><font color='#64748B'>symptom, cause, fix (AWS keys, blocked, freezes)</font>", body),
            Paragraph("<b>10  Cheat sheet & Queue</b><br/><font color='#64748B'>commands, words, freezeTracker, and keepAwake</font>", body)
        ],
    ]
    t_toc = Table(toc_data, colWidths=[260, 272])
    t_toc.setStyle(TableStyle([
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('LINEBELOW', (0, 0), (-1, -2), 0.5, c_border_light),
    ]))
    story.append(t_toc)
    story.append(Spacer(1, 24))

    for_box = [
        [Paragraph("<b>Who this is for</b>", body_bold)],
        [Paragraph(
            "Anyone who runs the script, reads its results, or needs to maintain it. You do not need to know the code to follow "
            "sections 1 to 5, 7, 8, 9, and 10. Section 6 is for engineers who inspect or modify the files. "
            "This guide is updated for the latest <b>merge-flow</b> branch containing deep Java, TypeScript, C#, and JavaScript "
            "validators, automated defect drafting, dual-account concurrency, and early blocked-run detection.",
            body
        )]
    ]
    t_for = Table(for_box, colWidths=[532])
    t_for.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), c_blue_box),
        ('BOX', (0, 0), (-1, -1), 0.8, c_bright_blue),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
    ]))
    story.append(t_for)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 2: 1 THE BIG PICTURE
    # =========================================================================
    story.append(Paragraph("1", sec_num))
    story.append(Paragraph("The big picture", sec_title))
    story.append(Paragraph("what the script does in one minute", sec_sub))

    story.append(Paragraph(
        "The script tests a branch on the Testable platform exactly like a person would, then checks what the platform wrote to "
        "AWS S3, and sends the result to the team. You give it one or more GitHub branch links. For every branch it does this:",
        body
    ))
    story.append(Spacer(1, 8))

    points = [
        "<b>Runs the branch on Testable with a real browser (Playwright):</b> connects the repository, picks the branch, presses Execute, waits for the analysis to finish, and takes screenshots and the taxonomy report.",
        "<b>Checks the evidence in S3:</b> for every technique it opens the tool's folder, reads the files, and says PASS, EMPTY or FAIL. Dedicated language validators (Python, Java, TypeScript, JavaScript, C#) judge whether each tool behaved correctly for that language and version.",
        "<b>Writes bug drafts (PDF, screenshot, Jira text):</b> automatically flags platform defects (missing tools, runner crashes, empty logs). Nothing is sent to Jira automatically without review.",
        "<b>Uploads the whole branch folder to SharePoint</b> and posts a card in Teams with the result, tool summary, and link."
    ]
    for pt in points:
        story.append(Paragraph(f"• {pt}", body))
        story.append(Spacer(1, 4))

    story.append(Spacer(1, 10))

    # Two-lane diagram table
    lane_diagram_data = [
        [
            Paragraph("<b>BROWSER LANE</b> (one branch at a time)", ParagraphStyle('BH', parent=body_bold, textColor=c_blue)),
            Paragraph("<b>BACKGROUND LANE</b> (no browser, runs beside next branch)", ParagraphStyle('WH', parent=body_bold, textColor=c_teal))
        ],
        [
            Paragraph("<b>You start it</b><br/>.env + builds.json or BRANCHES<br/><br/>"
                      "<b>Login</b> (auth.setup.ts)<br/>saves session to .auth/user.json<br/><br/>"
                      "<b>Main flow</b><br/>steps 1 to 15 on Testable (Playwright)<br/><br/>"
                      "<b>Hand-off</b><br/>job file written, next branch starts at once", body),
            Paragraph("<b>S3 check</b><br/>tool folders, validators, bug drafts, report<br/><br/>"
                      "<b>SharePoint</b><br/>whole branch folder uploaded (date/branch)<br/><br/>"
                      "<b>Teams card</b><br/>result + evidence link + tool summary<br/><br/>"
                      "<b>Next job</b><br/>or finish when queue is empty", body)
        ]
    ]
    t_lanes = Table(lane_diagram_data, colWidths=[260, 272])
    t_lanes.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, -1), c_card_bg),
        ('BACKGROUND', (1, 0), (1, -1), colors.HexColor("#F0FDFA")),
        ('BOX', (0, 0), (-1, -1), 0.8, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
    ]))
    story.append(t_lanes)
    story.append(Spacer(1, 12))

    story.append(Paragraph(
        "<b>The key idea of this branch:</b> after the browser part of a branch is finished, everything that does not need the browser "
        "(S3 check, SharePoint, Teams) moves to a background worker. The next branch starts on the platform right away, so "
        "the platform is never waiting for your reports to be written.",
        body
    ))
    story.append(Spacer(1, 12))

    rem_data = [
        [Paragraph("<b>Three things to remember</b>", body_bold)],
        [Paragraph("1. The browser lane runs one branch at a time.<br/>"
                   "2. The background lane works on branch N while branch N+1 is executing.<br/>"
                   "3. Every setting lives in <b>.env</b> (section 7). A change to .env always wins over a value typed in the terminal.", body)]
    ]
    t_rem = Table(rem_data, colWidths=[532])
    t_rem.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), c_light_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
    ]))
    story.append(t_rem)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 3: 2 THE PIPELINE
    # =========================================================================
    story.append(Paragraph("2", sec_num))
    story.append(Paragraph("The pipeline", sec_title))
    story.append(Paragraph("why the platform no longer sits idle", sec_sub))

    story.append(Paragraph(
        "Before, the script finished all the reports of a branch before it started the next one, so the platform waited. Now the "
        "reports are made by the background worker beside the browser:",
        body
    ))
    story.append(Spacer(1, 10))

    # Timeline comparison table
    pipe_table = [
        [Paragraph("<b>Model</b>", body_bold), Paragraph("<b>Execution Timeline</b>", body_bold), Paragraph("<b>Platform Efficiency</b>", body_bold)],
        [
            Paragraph("<b>BEFORE</b><br/>(inline)", body),
            Paragraph("Branch 1 [10m] -> S3 & Reports [4m] -> Branch 2 [10m] -> S3 & Reports [4m]", code_text),
            Paragraph("<font color='#DC2626'><b>~30% Idle Time</b><br/>Platform waits for reports</font>", body)
        ],
        [
            Paragraph("<b>NOW</b><br/>(merge-flow worker)", body),
            Paragraph("Browser: Branch 1 [10m] -> Branch 2 [10m] -> Branch 3 [10m] -> Logout<br/>"
                      "Worker:                  post 1 [4m] -> post 2 [4m] -> post 3 [4m]", code_text),
            Paragraph("<font color='#16A34A'><b>100% Efficiency</b><br/>Zero platform idle gap</font>", body)
        ]
    ]
    t_pipe = Table(pipe_table, colWidths=[90, 312, 130])
    t_pipe.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_blue),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_pipe)
    story.append(Spacer(1, 14))

    story.append(Paragraph("<b>The order of every run</b>", h3_style))
    story.append(Spacer(1, 4))

    order_data = [
        [Paragraph("<b>#</b>", body_bold), Paragraph("<b>Moment</b>", body_bold), Paragraph("<b>What happens</b>", body_bold), Paragraph("<b>Where you see it</b>", body_bold)],
        [Paragraph("1", body), Paragraph("Start", body), Paragraph("Branches are read from BRANCHES or builds.json. The run folder results/merge-flow_<date>_<time> is created.", body), Paragraph("Terminal / Test Explorer", body)],
        [Paragraph("2", body), Paragraph("Login", body), Paragraph("auth.setup.ts logs in with Testable credentials from .env and saves session in .auth/user.json.", body), Paragraph("test 'auth.setup.ts'", code_text)],
        [Paragraph("3", body), Paragraph("Branch N (Browser)", body), Paragraph("Main flow steps 1 to 15: connect repo, execute, wait, capture score, download taxonomy report.", body), Paragraph("test 'Whitebox run - <branch>'", code_text)],
        [Paragraph("4", body), Paragraph("Hand-off", body), Paragraph("When branch N passes, a job file is written to .postprocess/ and worker starts. Branch N+1 starts at once.", body), Paragraph("line 'handed to background worker'", code_text)],
        [Paragraph("5", body), Paragraph("Branch N (Worker)", body), Paragraph("S3 check, multi-language validation, bug drafts, SharePoint upload, Teams card. Runs beside branch N+1.", body), Paragraph("lines '[post] [branch] ...'", code_text)],
        [Paragraph("6", body), Paragraph("Logout", body), Paragraph("After the last branch finishes execution, the browser logs out of Testable.", body), Paragraph("test 'Logout'", code_text)],
        [Paragraph("7", body), Paragraph("Worker Finish", body), Paragraph("The final branch's post-processing completes; worker closes. The final verification test turns green.", body), Paragraph("test 'Background finishes'", code_text)],
    ]
    t_order = Table(order_data, colWidths=[24, 90, 278, 140])
    t_order.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 5),
    ]))
    story.append(t_order)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 4: 3 MAIN FLOW (THE 15 STEPS)
    # =========================================================================
    story.append(Paragraph("3", sec_num))
    story.append(Paragraph("Main flow", sec_title))
    story.append(Paragraph("the 15 steps the browser does for each branch", sec_sub))

    steps_overview = [
        [
            Paragraph("<b>Steps 1-2: Start</b><br/>Open chat, New analysis (first branch only)", body),
            Paragraph("<b>Steps 3-7: Pick Branch</b><br/>Connect repo, pick branch, tick 'On PR merge', confirm", body)
        ],
        [
            Paragraph("<b>Steps 8-9: Preview</b><br/>Coverage preview, language read, <b>early exit if blocked</b>", body),
            Paragraph("<b>Steps 10-12: Execute & Wait</b><br/>Execute run, open Confidence Engine, wait up to 35 min", body)
        ],
        [
            Paragraph("<b>Steps 13-15: Collect</b><br/>Score screenshot, gate values, taxonomy report download", body),
            Paragraph("<b>Hand-Off / Branch End</b><br/>Passed -> Worker queue; Blocked/Failed -> Teams alert", body)
        ]
    ]
    t_sov = Table(steps_overview, colWidths=[260, 272])
    t_sov.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), c_light_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_sov)
    story.append(Spacer(1, 8))

    story.append(Paragraph("<b>Detailed Step Inventory & Logic in MergeFlowPage.ts</b>", h3_style))
    
    step_detail_data = [
        [Paragraph("<b>Step</b>", body_bold), Paragraph("<b>Action & Logic in MergeFlowPage.ts</b>", body_bold), Paragraph("<b>Critical?</b>", body_bold), Paragraph("<b>Saved Output</b>", body_bold)],
        [Paragraph("0", body), Paragraph("Optional: with DUMMY_PR=yes, pushes a comment to branch README so platform sees fresh commit.", body), Paragraph("No", body), Paragraph("Git commit on remote", body)],
        [Paragraph("1", body), Paragraph("Opens Chat Execution Assistant (later branches use sidebar chat icon).", body), Paragraph("<b>Critical</b>", body), Paragraph("evidence/<branch>_1_PASS.png", code_text)],
        [Paragraph("2", body), Paragraph("First branch only: 'Can I safely deploy this commit?' -> New analysis / Refresh repos.", body), Paragraph("No", body), Paragraph("-", body)],
        [Paragraph("3", body), Paragraph("Change repository / branch -> Connect / Import repository. Waits for repo sync (cap 14m).", body), Paragraph("<b>Critical</b>", body), Paragraph("-", body)],
        [Paragraph("4", body), Paragraph("Clicks repository card -> Configure repository.", body), Paragraph("<b>Critical</b>", body), Paragraph("-", body)],
        [Paragraph("5", body), Paragraph("Selects branch: '+N branches', searches branch name, ticks checkbox, clicks Done.", body), Paragraph("<b>Critical</b>", body), Paragraph("-", body)],
        [Paragraph("6", body), Paragraph("Makes sure the 'On PR merge' trigger checkbox is ticked.", body), Paragraph("<b>Critical</b>", body), Paragraph("evidence screenshot", body)],
        [Paragraph("7", body), Paragraph("Confirms repository. If platform answers 'Branch unavailable', marks branch BLOCKED.", body), Paragraph("<b>Critical</b>", body), Paragraph("errors/site-error.txt", code_text)],
        [Paragraph("8", body), Paragraph("Coverage preview: repo structure, what will be analyzed. <b>NEW: waitSectionOrBlocked stops after 10s if blocked.</b>", body), Paragraph("No", body), Paragraph("01_, 02_, 03_ shots, repo-details.json", code_text)],
        [Paragraph("9", body), Paragraph("Continues from preview / Review branches. Stops if site blocks analysis.", body), Paragraph("<b>Critical</b>", body), Paragraph("-", body)],
        [Paragraph("10", body), Paragraph("Run plan -> Execute run. Retries if run does not trigger immediately.", body), Paragraph("<b>Critical</b>", body), Paragraph("evidence screenshot", body)],
        [Paragraph("11", body), Paragraph("Execution status -> Open Confidence Engine.", body), Paragraph("<b>Critical</b>", body), Paragraph("-", body)],
        [Paragraph("12", body), Paragraph("Waits for analysis to finish (polls green checkmark, default cap 35 min).", body), Paragraph("<b>Critical</b>", body), Paragraph("05_execution_status.png", code_text)],
        [Paragraph("13", body), Paragraph("Captures full screenshot of PR Confidence Analysis score.", body), Paragraph("No", body), Paragraph("04_pr_confidence_score.png", code_text)],
        [Paragraph("14", body), Paragraph("Reads every technique x classification gate value from UI. With GATE_SHOTS=on takes gate shots.", body), Paragraph("No", body), Paragraph("ui-values.json, gates/", code_text)],
        [Paragraph("15", body), Paragraph("Downloads taxonomy report HTML, saves run-details.json (Run ID, tenant, commit, branch), merges UI values.", body), Paragraph("No", body), Paragraph("taxonomy-gate-*.html, run-details.json", code_text)],
    ]
    t_sdetail = Table(step_detail_data, colWidths=[24, 280, 50, 178])
    t_sdetail.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 2.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2.5),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
    ]))
    story.append(t_sdetail)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 5: WHEN A BRANCH DOES NOT PASS & BACKGROUND WORKER HAND-OFF
    # =========================================================================
    story.append(Paragraph("When a branch does not pass", sec_title))
    story.append(Paragraph("how failures, blocks, and environment errors are handled safely", sec_sub))

    story.append(Paragraph(
        "A failed, blocked, or environment problem ends <b>that branch only</b>. A failure screenshot and network trace are saved in "
        "<code>errors/</code>, a failure alert card goes to Teams immediately, and the next branch starts. A branch that failed has "
        "no background post-processing because no platform run was produced.",
        body
    ))
    story.append(Spacer(1, 8))

    fail_types = [
        [Paragraph("<b>Status Code</b>", body_bold), Paragraph("<b>Trigger Condition</b>", body_bold), Paragraph("<b>Automated System Response</b>", body_bold)],
        [
            Paragraph("<b>BLOCKED</b>", body_bold),
            Paragraph("Site says 'Analysis is blocked on ...' or 'Branch unavailable'.", body),
            Paragraph("Stops in 10s via waitSectionOrBlocked. Saves errors/site-error.txt. Skips to next branch.", body)
        ],
        [
            Paragraph("<b>ENVIRONMENT</b>", body_bold),
            Paragraph("Site down, 502/504 Bad Gateway, repository sync hung.", body),
            Paragraph("Captures failure.png and network.json. Sends Teams failure card. Proceeds to next branch.", body)
        ],
        [
            Paragraph("<b>FAILED</b>", body_bold),
            Paragraph("Critical UI step timed out or button locator not found.", body),
            Paragraph("Saves error trace in errors/. Sends Teams card with failure reason screenshot. Moves to next branch.", body)
        ],
    ]
    t_ftypes = Table(fail_types, colWidths=[90, 180, 262])
    t_ftypes.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor("#FEE2E2")),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_ftypes)
    story.append(Spacer(1, 14))

    story.append(Paragraph("4", sec_num))
    story.append(Paragraph("Background worker", sec_title))
    story.append(Paragraph("what happens to a passed branch after the browser is done", sec_sub))

    story.append(Paragraph("<b>4.1 The Hand-Off (.postprocess/)</b>", h3_style))
    story.append(Paragraph(
        "The browser test and the worker communicate through atomic state files in <code>results/<run>/.postprocess/</code>. "
        "Nothing is lost if either process stops or restarts:",
        body
    ))
    story.append(Spacer(1, 6))

    handoff_files = [
        [Paragraph("<b>File in .postprocess/</b>", body_bold), Paragraph("<b>Operational Meaning & Lifecycle Role</b>", body_bold)],
        [Paragraph("<code><time>-<branch>.job.json</code>", code_text), Paragraph("A branch waiting to be post-processed by the worker.", body)],
        [Paragraph("<code>...job.json.running</code>", code_text), Paragraph("Currently being processed. If the worker crashes, it is automatically renamed back to .job.json so the next worker retries it.", body)],
        [Paragraph("<code>...done.json / ...failed.json</code>", code_text), Paragraph("Successfully completed or permanently failed jobs.", body)],
        [Paragraph("<code>worker.pid, CLOSE, worker.done</code>", code_text), Paragraph("Worker process registration, 'all branches sent', and 'worker finished'.", body)],
    ]
    t_hfiles = Table(handoff_files, colWidths=[180, 352])
    t_hfiles.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_hfiles)
    story.append(Spacer(1, 10))

    story.append(Paragraph("<b>4.2 What the Worker Does for Each Branch</b>", h3_style))
    worker_steps = [
        [Paragraph("<b>Order</b>", body_bold), Paragraph("<b>Step</b>", body_bold), Paragraph("<b>Details & Responsibilities</b>", body_bold), Paragraph("<b>If Failed</b>", body_bold)],
        [Paragraph("1", body), Paragraph("S3 Check", body), Paragraph("Reads AWS S3 tool folders, runs multi-language validators, writes s3-check.json and bug drafts.", body), Paragraph("Logged; SharePoint and Teams still run", body)],
        [Paragraph("2", body), Paragraph("SharePoint", body), Paragraph("Uploads the complete branch directory to team library (Automation Evidences Dump/date/branch).", body), Paragraph("Logged; Teams still runs", body)],
        [Paragraph("3", body), Paragraph("Teams", body), Paragraph("Posts success notification card with direct run link, SharePoint evidence link, and tool breakdown.", body), Paragraph("Marked failed; redo with npm run post", body)],
    ]
    t_wsteps = Table(worker_steps, colWidths=[36, 80, 276, 140])
    t_wsteps.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_wsteps)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 6: S3 CHECK & MULTI-LANGUAGE VALIDATION
    # =========================================================================
    story.append(Paragraph("4.3 The S3 check, explained", sec_title))
    story.append(Paragraph("how tool trigger status and multi-language logs are evaluated", sec_sub))

    story.append(Paragraph(
        "Every tool executed on the platform writes its artifacts to one dedicated S3 path built from the run record:<br/>"
        "<code>development/cell-001/&lt;tenant&gt;/&lt;project&gt;/&lt;repository&gt;/&lt;branch_id&gt;/&lt;branch&gt;/&lt;commit&gt;/&lt;run_id&gt;/&lt;tool&gt;/...</code>",
        body
    ))
    story.append(Spacer(1, 8))

    story.append(Paragraph("<b>The 8 Steps of the S3 Check Pipeline</b>", h3_style))
    s3_steps_data = [
        [
            Paragraph("<b>1. Find Run:</b> run-details.json gives tenant/repo/branch/run ID.", body),
            Paragraph("<b>2. List Folders:</b> scans S3 prefix -> s3-folders.json.", body)
        ],
        [
            Paragraph("<b>3. Pick Language:</b> coverage preview or branch prefix (JS_, TS_, PY_, CS_, JV_).", body),
            Paragraph("<b>4. Technique > Tool:</b> techniqueTools.ts resolves tool name candidates.", body)
        ],
        [
            Paragraph("<b>5. Read Files:</b> downloads JSON/XML tool files to s3-evidence/.", body),
            Paragraph("<b>6. Assign Verdict:</b> PASS (data), EMPTY (0 findings), FAIL (missing/error).", body)
        ],
        [
            Paragraph("<b>7. Language Validator:</b> deep checks for version compatibility & false empties.", body),
            Paragraph("<b>8. Generate Reports:</b> writes s3-check.json and bug drafts in bugs/.", body)
        ]
    ]
    t_s3steps = Table(s3_steps_data, colWidths=[260, 272])
    t_s3steps.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), c_light_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_s3steps)
    story.append(Spacer(1, 10))

    story.append(Paragraph("<b>Tool Verdicts Reference</b>", h3_style))
    verdicts_table = [
        [Paragraph("<b>Verdict</b>", body_bold), Paragraph("<b>Meaning</b>", body_bold), Paragraph("<b>Typical Reason / Evidence</b>", body_bold)],
        [Paragraph("<font color='#16A34A'><b>PASS</b></font>", body), Paragraph("The tool was triggered and produced valid output data.", body), Paragraph("e.g. lizard.xml with 123 functions, bandit.json with findings.", body)],
        [Paragraph("<font color='#D97706'><b>EMPTY</b></font>", body), Paragraph("Triggered, but report holds 0 findings or was marked not applicable.", body), Paragraph("status=not_applicable, baseline_missing, clean code (0 defects).", body)],
        [Paragraph("<font color='#DC2626'><b>FAIL</b></font>", body), Paragraph("Not triggered, missing tool folder, 0 bytes, or failure.json.", body), Paragraph("No folder in S3, [permanent_runner_error], container crash.", body)],
        [Paragraph("<b>N/A</b>", body), Paragraph("The tool does not apply to this specific taxonomy row.", body), Paragraph("Primary tool not applicable for this classification level.", body)],
    ]
    t_verdicts = Table(verdicts_table, colWidths=[60, 210, 262])
    t_verdicts.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 3.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_verdicts)
    story.append(Spacer(1, 10))

    story.append(Paragraph("<b>The 5 Dedicated Multi-Language Validators</b>", h3_style))
    val_table = [
        [Paragraph("<b>Language</b>", body_bold), Paragraph("<b>Validator File</b>", body_bold), Paragraph("<b>Evaluated Tools & Version Checks</b>", body_bold)],
        [Paragraph("<b>Java</b>", body), Paragraph("<code>utils/javaValidate.ts</code>", code_text), Paragraph("JaCoCo, SpotBugs, Checkstyle, PMD, PIT mutation testing across JDK 8, 11, 17, 21 and Maven/Gradle.", body)],
        [Paragraph("<b>TypeScript</b>", body), Paragraph("<code>utils/tsValidate.ts</code>", code_text), Paragraph("ESLint, TSC, JSCPD, Jest/Vitest coverage, Snyk across Node 18, 20, 22 and Webpack/Esbuild/Vite.", body)],
        [Paragraph("<b>JavaScript</b>", body), Paragraph("<code>utils/jsValidate.ts</code>", code_text), Paragraph("ESLint, JSCPD, Mocha/Istanbul, Retire.js across npm/yarn/pnpm mono and micro repos.", body)],
        [Paragraph("<b>C# (.NET)</b>", body), Paragraph("<code>utils/csValidate.ts</code>", code_text), Paragraph("Roslyn Analyzers, StyleCop, Coverlet/dotCover, SecurityCodeScan across .NET 6, 7, 8, 10.", body)],
        [Paragraph("<b>Python</b>", body), Paragraph("<code>utils/pyValidate.ts</code>", code_text), Paragraph("Coverage.py, Bandit, Pylint, Flake8, Lizard, Radon across Python 3.7 to 3.14.", body)],
    ]
    t_val = Table(val_table, colWidths=[80, 140, 312])
    t_val.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 3.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_val)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 7: BUG DRAFTS, SHAREPOINT & TEAMS
    # =========================================================================
    story.append(Paragraph("Bug drafts, SharePoint & Teams", sec_title))
    story.append(Paragraph("automated defect reporting and team distribution", sec_sub))

    story.append(Paragraph("<b>4.3 Automated Bug Drafts (utils/bugReport.ts)</b>", h3_style))
    story.append(Paragraph(
        "When the language validators detect a platform problem, <code>bugReport.ts</code> automatically generates a complete defect "
        "package into <code>results/&lt;run&gt;/&lt;branch&gt;/bugs/</code> without manual intervention:",
        body
    ))
    story.append(Spacer(1, 6))

    bug_items = [
        "<b>Defect Classification:</b> Classifies issues into <code>[Planning Defect]</code> (tool missing from plan), <code>[False Empty Defect]</code> (tool reported 0 findings after scanning 0 files), <code>[Runner Execution Defect]</code> (container error/crash), or <code>[Language Contamination]</code> (wrong language tool triggered).",
        "<b>Executive PDF Bug Report:</b> A clean 2-page PDF report detailing the exact failure, S3 path, tool parameters, and error excerpt.",
        "<b>Visual Screenshot:</b> Captures a targeted crop of the taxonomy report row showing the failure.",
        "<b>Jira Text File:</b> Pre-formats a ready-to-paste Jira ticket description with reproduction steps and native attachment links."
    ]
    for bi in bug_items:
        story.append(Paragraph(f"• {bi}", body))
        story.append(Spacer(1, 3))

    story.append(Spacer(1, 8))

    story.append(Paragraph("<b>4.4 SharePoint Upload & _RUN Naming</b>", h3_style))
    story.append(Paragraph(
        "Uploads the entire branch folder to <b>Automation Evidences Dump</b> on the team site. It uses a tiered connection strategy:",
        body
    ))
    story.append(Spacer(1, 6))

    sp_table = [
        [Paragraph("<b>Priority</b>", body_bold), Paragraph("<b>Method</b>", body_bold), Paragraph("<b>Configuration & Behavior</b>", body_bold)],
        [Paragraph("1 (Best)", body), Paragraph("Microsoft Graph API", body), Paragraph("Requires <code>SP_CLIENT_ID</code> and <code>SP_TENANT_ID</code> in .env. Unattended token refresh.", body)],
        [Paragraph("2 (Easiest)", body), Paragraph("Personal Session", body), Paragraph("Run <code>npm run sp:login</code> once. Uses saved browser session in .auth/. No admin required.", body)],
        [Paragraph("3 (Fallback)", body), Paragraph("OneDrive Shortcut", body), Paragraph("Requires <code>SHAREPOINT_DIR</code> path. Copies to local synced OneDrive directory.", body)],
    ]
    t_sp = Table(sp_table, colWidths=[60, 130, 342])
    t_sp.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 3.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_sp)
    story.append(Spacer(1, 4))
    story.append(Paragraph("<i>Note: Multiple runs of the same branch on the same day automatically append <code>_RUN2</code>, <code>_RUN3</code> to avoid overwriting earlier runs.</i>", body_muted))

    story.append(Spacer(1, 8))

    story.append(Paragraph("<b>4.5 Microsoft Teams Integration</b>", h3_style))
    teams_table = [
        [Paragraph("<b>Notification Type</b>", body_bold), Paragraph("<b>Timing</b>", body_bold), Paragraph("<b>Card Contents & Actions</b>", body_bold)],
        [
            Paragraph("<b>Success Card</b>", body_bold),
            Paragraph("Sent by background worker after S3 & SharePoint", body),
            Paragraph("Branch name, repo, QA/DEV environment, execution duration; direct buttons: 'Open Run on Site' and 'Open SharePoint Evidence'; tool breakdown summary.", body)
        ],
        [
            Paragraph("<b>Failure Card</b>", body_bold),
            Paragraph("Sent by browser test immediately upon failure", body),
            Paragraph("Branch name, failure classification (failed / blocked / environment), exact error message, and failure screenshot attachment.", body)
        ],
        [
            Paragraph("<b>Queue Abort Card</b>", body_bold),
            Paragraph("Sent by queue server if round stalls", body),
            Paragraph("Alerts team if login or platform site is unreachable before a branch can begin.", body)
        ],
    ]
    t_teams = Table(teams_table, colWidths=[90, 140, 302])
    t_teams.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 3.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_teams)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 8: 5 HOW TO USE IT (SETUP & CHECKLIST)
    # =========================================================================
    story.append(Paragraph("5", sec_num))
    story.append(Paragraph("How to use it", sec_title))
    story.append(Paragraph("one-time setup, then the same checklist every run", sec_sub))

    story.append(Paragraph("<b>5.1 One-Time Setup (Per Machine)</b>", h3_style))
    
    setup_steps = [
        [Paragraph("<b>#</b>", body_bold), Paragraph("<b>Action Item</b>", body_bold), Paragraph("<b>Command or Location</b>", body_bold)],
        [Paragraph("1", body), Paragraph("Install Node.js 22 LTS, Git, and Python 3.11+. Clone repository and switch to merge-flow.", body), Paragraph("<code>git checkout merge-flow</code>", code_text)],
        [Paragraph("2", body), Paragraph("Install Node dependencies (Playwright, AWS SDK, exceljs, tsx).", body), Paragraph("<code>npm install</code>", code_text)],
        [Paragraph("3", body), Paragraph("Install the Playwright Chromium browser binaries.", body), Paragraph("<code>npx playwright install chromium</code>", code_text)],
        [Paragraph("4", body), Paragraph("Copy .env.example to .env and configure credentials (section 7).", body), Paragraph("<code>Copy-Item .env.example .env</code>", code_text)],
        [Paragraph("5", body), Paragraph("Sign in to SharePoint once with your Microsoft work account.", body), Paragraph("<code>npm run sp:login</code>", code_text)],
        [Paragraph("6", body), Paragraph("Verify Python virtual environment (if running CLI tools or EKS mentor).", body), Paragraph("<code>pip install -r requirements.txt</code>", code_text)],
    ]
    t_ssetup = Table(setup_steps, colWidths=[24, 290, 218])
    t_ssetup.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_ssetup)
    story.append(Spacer(1, 10))

    story.append(Paragraph("<b>5.2 Daily Pre-Run Checklist</b>", h3_style))
    chk_data = [
        [Paragraph("<b>#</b>", body_bold), Paragraph("<b>Step</b>", body_bold), Paragraph("<b>Why It Matters</b>", body_bold)],
        [Paragraph("1", body), Paragraph("Refresh AWS keys in .env (AWS IAM Identity Center -> QA-S3-Readonly -> Access keys).", body), Paragraph("AWS temporary credentials expire after several hours; avoids ExpiredToken error.", body)],
        [Paragraph("2", body), Paragraph("Put target branch URLs into builds.json or set $env:BRANCHES in PowerShell.", body), Paragraph("Defines the execution queue for the runner.", body)],
        [Paragraph("3", body), Paragraph("Start the test run. A Chromium window opens. <b>Do not minimize or lock screen.</b>", body), Paragraph("The headed browser needs active viewport rendering for screenshots.", body)],
        [Paragraph("4", body), Paragraph("Do not edit .env or config files while the run is active.", body), Paragraph("Modifying configs triggers a hot reload and terminates active sessions.", body)],
        [Paragraph("5", body), Paragraph("Monitor terminal progress. Look for <code>[post] [branch]</code> output lines.", body), Paragraph("Confirms the background worker is processing S3 artifacts concurrently.", body)],
        [Paragraph("6", body), Paragraph("When 'Background post-processing finishes' turns green, execution is complete.", body), Paragraph("All S3 checks, SharePoint uploads, and Teams cards are finished.", body)],
        [Paragraph("7", body), Paragraph("Run <code>git checkout builds.json</code> to keep your git working tree clean.", body), Paragraph("Prevents personal test branch URLs from accidentally being committed.", body)],
    ]
    t_chk = Table(chk_data, colWidths=[24, 276, 232])
    t_chk.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 3.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_chk)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 9: STARTING RUNS, COMMANDS & PARALLEL LANES
    # =========================================================================
    story.append(Paragraph("5.3 Two ways to start a run", sec_title))
    story.append(Paragraph("terminal commands and test explorer workflows", sec_sub))

    ways_data = [
        [
            Paragraph("<b>Method A: PowerShell Terminal</b>", body_bold),
            Paragraph("<b>Method B: VS Code / Antigravity Test Explorer</b>", body_bold)
        ],
        [
            Paragraph("Set target branch URLs and run:<br/>"
                      "<code>$env:BRANCHES=\"https://github.com/OWNER/REPO/tree/BRANCH1,https://github.com/OWNER/REPO/tree/BRANCH2\"</code><br/>"
                      "<code>npm test</code><br/><br/>"
                      "<i>Multiple branches can be comma-separated. The repo is inferred directly from the GitHub link.</i>", body),
            Paragraph("1. Open <code>builds.json</code> and paste branch links.<br/>"
                      "2. Click the Refresh icon in the Testing panel.<br/>"
                      "3. Ensure <b>Show browser</b> is toggled on.<br/>"
                      "4. Run the entire <b>flow</b> project (do not run individual step tests singly).", body)
        ]
    ]
    t_ways = Table(ways_data, colWidths=[260, 272])
    t_ways.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), c_light_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
    ]))
    story.append(t_ways)
    story.append(Spacer(1, 10))

    story.append(Paragraph("<b>5.4 Commands Reference Table</b>", h3_style))
    cmd_data = [
        [Paragraph("<b>Command</b>", body_bold), Paragraph("<b>Purpose & Operational Description</b>", body_bold)],
        [Paragraph("<code>npm test</code>", code_bold), Paragraph("Executes the complete flow: login, all branches in builds.json, logout, and background worker drain.", body)],
        [Paragraph("<code>npm run setup</code>", code_bold), Paragraph("Only performs the Testable login and saves session to .auth/user.json. Use to verify credentials.", body)],
        [Paragraph("<code>npm run sp:login</code>", code_bold), Paragraph("Launches interactive Microsoft browser login for SharePoint upload access token.", body)],
        [Paragraph("<code>npm run s3</code>", code_bold), Paragraph("Standalone S3 audit of an existing results directory without re-running the browser UI.", body)],
        [Paragraph("<code>npm run post -- \"&lt;dir&gt;\"</code>", code_bold), Paragraph("Re-runs post-processing (S3 check, bug drafts, SharePoint, Teams) for a specific finished branch folder.", body)],
        [Paragraph("<code>npm run queue</code>", code_bold), Paragraph("Starts the local Express queue management server on http://localhost:3000.", body)],
        [Paragraph("<code>npm run parallel</code>", code_bold), Paragraph("Executes dual-account concurrent lanes (Account 1 and Account 2) simultaneously on one PC.", body)],
    ]
    t_cmd = Table(cmd_data, colWidths=[150, 382])
    t_cmd.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 3.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_cmd)
    story.append(Spacer(1, 10))

    story.append(Paragraph("<b>5.5 Two Testable Accounts on One PC (Parallel Lanes)</b>", h3_style))
    story.append(Paragraph(
        "To run two accounts concurrently on the same machine without collisions, configure <code>TESTABLE_EMAIL_2</code> and "
        "<code>TESTABLE_PASSWORD_2</code> in <code>.env</code>. Then run <code>npm run parallel</code>. Account 2 uses its own isolated "
        "storage state (<code>.auth/user-2.json</code>) and results folder (<code>..._acct2</code>). Work is dynamically distributed across both accounts.",
        body
    ))

    story.append(PageBreak())

    # =========================================================================
    # PAGE 10: 6 PROJECT LAYOUT (ROOT, PAGES, TESTS)
    # =========================================================================
    story.append(Paragraph("6", sec_num))
    story.append(Paragraph("File map", sec_title))
    story.append(Paragraph("which file does which job in the repository", sec_sub))

    story.append(Paragraph(
        "The system is organized into decoupled functional layers. The table below documents every file in the root, pages, and tests directories:",
        body
    ))
    story.append(Spacer(1, 6))

    files_p10 = [
        [Paragraph("<b>File / Path</b>", body_bold), Paragraph("<b>Function & Responsibility</b>", body_bold)],
        [Paragraph("<b>Project Root</b>", body_bold), Paragraph("<b>Configuration & Environment</b>", body_bold)],
        [Paragraph("<code>package.json</code>", code_text), Paragraph("Defines project metadata, dependencies (Playwright, AWS SDK, exceljs, tsx), and npm runner scripts.", body)],
        [Paragraph("<code>playwright.config.ts</code>", code_text), Paragraph("Main Playwright configuration. Configures headed Chromium, 1 worker, 35m timeouts, device scale factor, and test projects (setup, flow, s3).", body)],
        [Paragraph("<code>tsconfig.json</code>", code_text), Paragraph("TypeScript compiler configuration enforcing strict type checking and modern module resolution.", body)],
        [Paragraph("<code>builds.json</code>", code_text), Paragraph("Input JSON array of target GitHub branch URLs. Rewritten by queue server during automated rounds.", body)],
        [Paragraph("<code>.env / .env.example</code>", code_text), Paragraph("Central secrets file: Testable login, AWS access keys, Teams webhook, SharePoint targets. Never committed.", body)],
        [Paragraph("<code>.gitignore</code>", code_text), Paragraph("Prevents secrets (.env), sessions (.auth/), test results (results/), and cache from entering git.", body)],
        [Paragraph("<b>pages/</b>", body_bold), Paragraph("<b>UI Interaction & Selectors</b>", body_bold)],
        [Paragraph("<code>MergeFlowPage.ts</code>", code_text), Paragraph("Comprehensive Page Object encapsulating all 15 Testable UI steps. Contains self-healing locators, chat assistant handling, coverage preview inspection, Confidence Engine polling, and early blocked-run detection (waitSectionOrBlocked).", body)],
        [Paragraph("<b>tests/</b>", body_bold), Paragraph("<b>Test Runners & Specs</b>", body_bold)],
        [Paragraph("<code>auth.setup.ts</code>", code_text), Paragraph("Initial authentication test. Logs into Testable (or Okta SSO) and writes persistent browser state to .auth/user.json.", body)],
        [Paragraph("<code>merge-flow.spec.ts</code>", code_text), Paragraph("Main branch execution spec. Iterates through builds.json, executes steps 1-15, saves network traces on failure, and hands off jobs to the background queue.", body)],
        [Paragraph("<code>s3-evidence.spec.ts</code>", code_text), Paragraph("Standalone S3 evidence verification spec for re-evaluating historical results folders without opening the browser.", body)],
    ]
    t_p10 = Table(files_p10, colWidths=[160, 372])
    t_p10.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BACKGROUND', (0, 1), (-1, 1), c_light_bg),
        ('BACKGROUND', (0, 8), (-1, 8), c_light_bg),
        ('BACKGROUND', (0, 10), (-1, 10), c_light_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_p10)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 11: 6.2 UTILS & QUEUE SERVER FILES
    # =========================================================================
    story.append(Paragraph("6.2 utils/ and queue-server/ files", sec_title))
    story.append(Paragraph("the backend engines for S3, validation, reporting, and queue management", sec_sub))

    files_p11 = [
        [Paragraph("<b>File in utils/</b>", body_bold), Paragraph("<b>Detailed Responsibility & Role</b>", body_bold)],
        [Paragraph("<code>awsS3.ts</code>", code_text), Paragraph("AWS S3 client wrapper handling authentication, prefix listing, exponential backoff retries, and token expiry detection.", body)],
        [Paragraph("<code>s3Evidence.ts</code>", code_text), Paragraph("Core S3 evidence scanner. Builds inventory, matches candidate tools, downloads logs, and assigns PASS/EMPTY/FAIL verdicts.", body)],
        [Paragraph("<code>s3Check.ts</code>", code_text), Paragraph("Inspects individual tool JSON/XML log contents, verifies structure, and detects programming languages.", body)],
        [Paragraph("<code>techniqueTools.ts</code>", code_text), Paragraph("Master catalog dictionary defining primary and secondary tool mappings per testing type and technique across languages.", body)],
        [Paragraph("<code>mergeTaxonomy.ts</code>", code_text), Paragraph("Merges S3 tool validation columns into the platform's HTML taxonomy report (*-with-ui-values.html).", body)],
        [Paragraph("<code>pyValidate.ts</code>", code_text), Paragraph("Deep validator for Python tools (Coverage.py, Bandit, Pylint, Lizard, Radon) checking version-specific rules.", body)],
        [Paragraph("<code>javaValidate.ts</code>", code_text), Paragraph("Deep validator for Java tools (JaCoCo, SpotBugs, Checkstyle, PMD, PIT) across JDK versions and build tools.", body)],
        [Paragraph("<code>tsValidate.ts / jsValidate.ts</code>", code_text), Paragraph("Deep validators for TypeScript and JavaScript tools (ESLint, TSC, JSCPD, Jest/Vitest, Retire.js).", body)],
        [Paragraph("<code>csValidate.ts</code>", code_text), Paragraph("Deep validator for C# (.NET) tools (Roslyn Analyzers, StyleCop, Coverlet/dotCover).", body)],
        [Paragraph("<code>bugReport.ts</code>", code_text), Paragraph("Defect reporting engine that builds 2-page PDF bug reports, row screenshots, and Jira Markdown bodies.", body)],
        [Paragraph("<code>postprocess*.ts</code>", code_text), Paragraph("Asynchronous worker queue implementing file-based job scheduling (.postprocess/) and worker lifecycle.", body)],
        [Paragraph("<code>sharepoint*.ts / spLogin.ts</code>", code_text), Paragraph("SharePoint client supporting Microsoft Graph API, interactive personal sign-in, and OneDrive shortcut copies.", body)],
        [Paragraph("<code>teams.ts / teamsWorker.js</code>", code_text), Paragraph("Constructs and dispatches rich adaptive cards to Microsoft Teams webhooks with tool summary tables.", body)],
        [Paragraph("<code>parallelRun.ts</code>", code_text), Paragraph("Concurrent scheduler managing dual-account execution lanes without test artifact collisions.", body)],
        [Paragraph("<b>queue-server/</b>", body_bold), Paragraph("<b>Local Queue Dashboard & Reliability Engines</b>", body_bold)],
        [Paragraph("<code>server.js</code>", code_text), Paragraph("Express server on Port 3000 providing web dashboard and REST API for team branch queuing.", body)],
        [Paragraph("<code>freezeTracker.js</code>", code_text), Paragraph("Watchdog monitoring branch startup. Detects inactivity > 8 minutes and restarts frozen runs automatically.", body)],
        [Paragraph("<code>keepAwake.js</code>", code_text), Paragraph("Prevents Windows OS sleep/idle suspension during long overnight batch validation runs.", body)],
    ]
    t_p11 = Table(files_p11, colWidths=[160, 372])
    t_p11.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BACKGROUND', (0, 14), (-1, 14), c_light_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 2.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2.5),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_p11)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 12: 7 .ENV SETTINGS REFERENCE
    # =========================================================================
    story.append(Paragraph("7", sec_num))
    story.append(Paragraph(".env settings reference", sec_title))
    story.append(Paragraph("every configuration variable, what to put, and defaults", sec_sub))

    env_data = [
        [Paragraph("<b>Variable</b>", body_bold), Paragraph("<b>Required?</b>", body_bold), Paragraph("<b>Meaning & Valid Values</b>", body_bold), Paragraph("<b>Default</b>", body_bold)],
        [Paragraph("<code>TEST_ENV</code>", code_text), Paragraph("Yes", body), Paragraph("Platform environment to target: qa (qa-app.testable.cloud) or dev.", body), Paragraph("qa", code_text)],
        [Paragraph("<code>TESTABLE_EMAIL</code>", code_text), Paragraph("Yes", body), Paragraph("Login email address for the Testable platform account.", body), Paragraph("-", body)],
        [Paragraph("<code>TESTABLE_PASSWORD</code>", code_text), Paragraph("Yes", body), Paragraph("Password for the primary Testable platform account.", body), Paragraph("-", body)],
        [Paragraph("<code>TESTABLE_EMAIL_DEV</code>", code_text), Paragraph("For dev", body), Paragraph("Login email for dev environment (used when TEST_ENV=dev).", body), Paragraph("-", body)],
        [Paragraph("<code>AWS_ACCESS_KEY_ID</code>", code_text), Paragraph("For S3", body), Paragraph("Temporary AWS Access Key ID from IAM Identity Center (QA-S3-Readonly).", body), Paragraph("-", body)],
        [Paragraph("<code>AWS_SECRET_ACCESS_KEY</code>", code_text), Paragraph("For S3", body), Paragraph("Temporary AWS Secret Access Key.", body), Paragraph("-", body)],
        [Paragraph("<code>AWS_SESSION_TOKEN</code>", code_text), Paragraph("For S3", body), Paragraph("Temporary AWS Session Token (must be refreshed when expired).", body), Paragraph("-", body)],
        [Paragraph("<code>AWS_REGION</code>", code_text), Paragraph("Yes", body), Paragraph("AWS region where evidence S3 bucket resides.", body), Paragraph("us-east-2", code_text)],
        [Paragraph("<code>TEAMS_WEBHOOK_URL</code>", code_text), Paragraph("Optional", body), Paragraph("Microsoft Teams workflow webhook URL. Empty = no Teams alerts sent.", body), Paragraph("empty", body)],
        [Paragraph("<code>POSTPROCESS</code>", code_text), Paragraph("Optional", body), Paragraph("background = run S3/reports in background worker; inline = sequential.", body), Paragraph("background", code_text)],
        [Paragraph("<code>DUMMY_PR</code>", code_text), Paragraph("Optional", body), Paragraph("yes = push comment to branch README before run to force fresh commit.", body), Paragraph("no", code_text)],
        [Paragraph("<code>GATE_SHOTS</code>", code_text), Paragraph("Optional", body), Paragraph("on = screenshot every gate; off = only extract gate score values.", body), Paragraph("off", code_text)],
        [Paragraph("<code>RUN_TIMEOUT_MIN</code>", code_text), Paragraph("Optional", body), Paragraph("Maximum minutes to wait for analysis to complete on platform.", body), Paragraph("35", code_text)],
        [Paragraph("<code>SP_TENANT_ID / CLIENT_ID</code>", code_text), Paragraph("Optional", body), Paragraph("Microsoft Graph App Registration for unattended SharePoint upload.", body), Paragraph("-", body)],
        [Paragraph("<code>SHAREPOINT_DIR</code>", code_text), Paragraph("Optional", body), Paragraph("Local OneDrive synced path for team evidence folder upload.", body), Paragraph("-", body)],
        [Paragraph("<code>TESTABLE_EMAIL_2</code>", code_text), Paragraph("Parallel", body), Paragraph("Second account email for dual-account concurrent execution (npm run parallel).", body), Paragraph("-", body)],
    ]
    t_env = Table(env_data, colWidths=[140, 60, 262, 70])
    t_env.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ('LEFTPADDING', (0, 0), (-1, -1), 5),
    ]))
    story.append(t_env)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 13: 8 RESULT FOLDERS & OUTPUT ARTIFACTS
    # =========================================================================
    story.append(Paragraph("8", sec_num))
    story.append(Paragraph("Result folders", sec_title))
    story.append(Paragraph("what each output file is in results/merge-flow_<timestamp>/", sec_sub))

    story.append(Paragraph(
        "Every execution creates a dedicated run directory under <code>results/merge-flow_&lt;date&gt;_&lt;time&gt;/</code>. "
        "Inside, each branch has its own complete subfolder containing all evidence:",
        body
    ))
    story.append(Spacer(1, 8))

    res_tree_data = [
        [Paragraph("<b>Path / Artifact Name</b>", body_bold), Paragraph("<b>Artifact Content & Functional Purpose</b>", body_bold)],
        [Paragraph("<code>taxonomy-gate-*.html</code>", code_text), Paragraph("Official HTML gate report downloaded directly from Testable platform.", body)],
        [Paragraph("<code>*-with-ui-values.html</code>", code_text), Paragraph("Enhanced HTML report merging UI gate scores with AWS S3 tool execution columns.", body)],
        [Paragraph("<code>run-details.json</code>", code_text), Paragraph("JSON record of the run: tenant_id, project_id, branch_id, commit_sha, and run_id.", body)],
        [Paragraph("<code>repo-details.json</code>", code_text), Paragraph("Language, build type, and framework detected during the coverage preview.", body)],
        [Paragraph("<code>ui-values.json</code>", code_text), Paragraph("Raw key-value pairs of every technique and classification score read from the UI.", body)],
        [Paragraph("<code>s3-check.json</code>", code_text), Paragraph("Complete verdict manifest: every tool evaluated with PASS / EMPTY / FAIL and note.", body)],
        [Paragraph("<code>s3-folders.json</code>", code_text), Paragraph("List of all directories created by tools in the AWS S3 run prefix.", body)],
        [Paragraph("<code>s3-files.json</code>", code_text), Paragraph("Heads and excerpts of all JSON and XML files found in S3.", body)],
        [Paragraph("<code>s3-evidence/</code>", code_text), Paragraph("Local directory containing all downloaded raw tool output files (logs, XML, JSON).", body)],
        [Paragraph("<code>bugs/</code>", code_text), Paragraph("Generated defect drafts: 2-page PDF bug reports, failure row crops, and Jira text.", body)],
        [Paragraph("<code>errors/</code>", code_text), Paragraph("Captured failure.png screenshots, network.json traces, and site-error.txt (if blocked).", body)],
        [Paragraph("<code>postprocess.json</code>", code_text), Paragraph("Background worker status tracker: records state of S3, SharePoint, and Teams jobs.", body)],
        [Paragraph("<code>postprocess.log</code>", code_text), Paragraph("Complete console log of the background post-processing worker.", body)],
    ]
    t_res = Table(res_tree_data, colWidths=[170, 362])
    t_res.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 3.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_res)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 14: 9 TROUBLESHOOTING PLAYBOOK
    # =========================================================================
    story.append(Paragraph("9", sec_num))
    story.append(Paragraph("Troubleshooting", sec_title))
    story.append(Paragraph("symptom, root cause, and immediate resolution", sec_sub))

    tb_data = [
        [Paragraph("<b>Observed Symptom</b>", body_bold), Paragraph("<b>Likely Root Cause</b>", body_bold), Paragraph("<b>Immediate Fix Procedure</b>", body_bold)],
        [
            Paragraph("<b>AWS keys expired / S3 check skipped</b>", body_bold),
            Paragraph("AWS temporary session tokens expired.", body),
            Paragraph("Copy fresh keys from AWS Portal into .env. Redo check via: <code>npm run post -- \"&lt;folder&gt;\"</code>.", body)
        ],
        [
            Paragraph("<b>Branch stops: BLOCKED by site</b>", body_bold),
            Paragraph("Site says 'Analysis is blocked on ...' or commit already tested.", body),
            Paragraph("Normal behavior: waitSectionOrBlocked exits in 10s. Set <code>DUMMY_PR=yes</code> in .env to push fresh commit.", body)
        ],
        [
            Paragraph("<b>Browser Zoom / Layout Shift</b>", body_bold),
            Paragraph("Windows OS scaling (125% / 150%) shifts button coordinates.", body),
            Paragraph("Config sets <code>--force-device-scale-factor=1</code>. For custom scale: <code>$env:PAGE_SCALE=\"0.9\"</code>.", body)
        ],
        [
            Paragraph("<b>Runner freezes at start of branch</b>", body_bold),
            Paragraph("Platform navigation stalls or network handshake hangs.", body),
            Paragraph("The built-in <code>freezeTracker.js</code> automatically detects inactivity > 8m and restarts the queue safely.", body)
        ],
        [
            Paragraph("<b>Machine sleeps during overnight run</b>", body_bold),
            Paragraph("Windows power-saving policy puts machine to sleep.", body),
            Paragraph("Run queue via <code>npm run queue</code>. It runs <code>keepAwake.js</code> issuing power assertions to prevent sleep.", body)
        ],
        [
            Paragraph("<b>RUN-MISMATCH.txt in branch folder</b>", body_bold),
            Paragraph("The run opened on the site belongs to another branch.", body),
            Paragraph("Do not trust that folder. Run the branch again to ensure correct association.", body)
        ],
        [
            Paragraph("<b>A terminal variable is ignored</b>", body_bold),
            Paragraph(".env file values always win over terminal environment variables.", body),
            Paragraph("Edit the variable directly in <code>.env</code> instead of setting it in the terminal.", body)
        ],
    ]
    t_tb = Table(tb_data, colWidths=[140, 140, 252])
    t_tb.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_tb)
    story.append(Spacer(1, 14))

    first_box = [
        [Paragraph("<b>First place to look when debugging</b>", body_bold)],
        [Paragraph(
            "For any problem after a branch finishes: open <code>&lt;branch folder&gt;/postprocess.json</code>. It tells you which of S3, "
            "SharePoint, and Teams succeeded or failed and shows the exact error message. The full log is in <code>postprocess.log</code>.",
            body
        )]
    ]
    t_first = Table(first_box, colWidths=[532])
    t_first.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), c_amber_box),
        ('BOX', (0, 0), (-1, -1), 0.8, colors.HexColor("#D97706")),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
    ]))
    story.append(t_first)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 15: 10 CHEAT SHEET & OPTIONAL QUEUE
    # =========================================================================
    story.append(Paragraph("10", sec_num))
    story.append(Paragraph("Cheat sheet", sec_title))
    story.append(Paragraph("commands, terminology, and the team queue server", sec_sub))

    story.append(Paragraph("<b>Words Used in This Guide</b>", h3_style))
    words_data = [
        [Paragraph("<b>Term</b>", body_bold), Paragraph("<b>Definition</b>", body_bold)],
        [Paragraph("<b>Branch folder</b>", body), Paragraph("results/&lt;run&gt;/&lt;branch_name&gt;/ : houses all reports, screenshots, and evidence for one branch.", body)],
        [Paragraph("<b>Main flow / Browser lane</b>", body), Paragraph("The 15 sequential UI steps executed in Playwright Chromium on the Testable site.", body)],
        [Paragraph("<b>Worker / Background lane</b>", body), Paragraph("The decoupled Node.js process performing S3 checks, validation, SharePoint uploads, and Teams cards.", body)],
        [Paragraph("<b>Hand-off</b>", body), Paragraph("The moment a passed branch writes a job file to .postprocess/ and allows the next branch to start.", body)],
        [Paragraph("<b>Platform defect</b>", body), Paragraph("A bug belonging to Testable (missing tool, runner crash, false empty) rather than the user's code.", body)],
        [Paragraph("<b>Blocked / Environment / Failed</b>", body), Paragraph("The 3 exit statuses: platform rejected run, network/site unavailable, or UI step assertion failed.", body)],
    ]
    t_words = Table(words_data, colWidths=[150, 382])
    t_words.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), c_card_bg),
        ('BOX', (0, 0), (-1, -1), 0.5, c_border),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, c_border),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_words)
    story.append(Spacer(1, 10))

    story.append(Paragraph("<b>The Team Branch Queue Server (npm run queue)</b>", h3_style))
    story.append(Paragraph(
        "When multiple team members submit validation branches, launch <code>npm run queue</code> and open <code>http://localhost:3000</code>. "
        "Engineers enter their branch links and name. The server owner types <code>start</code> in the terminal. The queue serves one "
        "branch from each waiting person in a fair round-robin order. It incorporates <code>freezeTracker.js</code> to auto-recover "
        "stalled runs and <code>keepAwake.js</code> to prevent system sleep.",
        body
    ))
    story.append(Spacer(1, 10))

    story.append(Paragraph("<b>About This Document</b>", h3_style))
    story.append(Paragraph(
        "This manual describes the <b>merge-flow</b> branch at commit <code>fd4e101</code>. When code or selector logic in "
        "<code>pages/MergeFlowPage.ts</code> or <code>utils/</code> is updated, update the corresponding section in this guide. "
        "The automation logs its operations in real time; when in doubt, trust the live logs and <code>postprocess.json</code>.",
        body
    ))

    # Build PDF
    doc.build(story, canvasmaker=WorkflowGuideCanvas)
    print(f"Generated merge-flow guide at: {Path(pdf_filename).resolve()}")

    downloads_path = Path(r"C:\Users\SAKTHI SUDHARSHAN\Downloads")
    if downloads_path.exists():
        dest = downloads_path / pdf_filename
        shutil.copy(pdf_filename, dest)
        print(f"Copied to Downloads: {dest}")

if __name__ == "__main__":
    create_merge_flow_guide()

