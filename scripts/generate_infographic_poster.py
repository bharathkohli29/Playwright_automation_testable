import os
import shutil
from pathlib import Path
import matplotlib.pyplot as plt
import matplotlib.patches as patches

OUTPUT_DIR = Path("f:/Tool Validation Automation")
ASSETS_DIR = OUTPUT_DIR / "assets" / "diagrams"
ASSETS_DIR.mkdir(parents=True, exist_ok=True)

PNG_POSTER = OUTPUT_DIR / "Automated_CI_CD_Bot_Architecture_Poster.png"
PDF_POSTER = OUTPUT_DIR / "Automated_CI_CD_Bot_Architecture_Poster.pdf"
DOWNLOADS_PNG = Path(os.path.expanduser("~")) / "Downloads" / "Automated_CI_CD_Bot_Architecture_Poster.png"
DOWNLOADS_PDF = Path(os.path.expanduser("~")) / "Downloads" / "Automated_CI_CD_Bot_Architecture_Poster.pdf"


def draw_poster():
    # 12 inches wide x 23.5 inches tall at 300 DPI => 3600 x 7050 px
    fig, ax = plt.subplots(figsize=(12, 23.5), dpi=300)
    
    # Modern sleek dark tech palette
    bg_color = "#0B0F19"
    card_bg = "#111827"
    card_border = "#1F2937"
    text_white = "#F9FAFB"
    text_muted = "#94A3B8"
    accent_blue = "#38BDF8"
    accent_indigo = "#818CF8"
    accent_emerald = "#34D399"
    accent_amber = "#FBBF24"
    accent_rose = "#FB7185"
    accent_purple = "#C084FC"
    
    fig.patch.set_facecolor(bg_color)
    ax.set_facecolor(bg_color)
    
    # Coordinate system: x from 0 to 12, y from 0 to 23.5
    ax.set_xlim(0, 12)
    ax.set_ylim(0, 23.5)
    ax.axis('off')

    # =========================================================================
    # 1. HERO HEADER BANNER (y: 21.6 to 23.1)
    # =========================================================================
    header_box = patches.FancyBboxPatch(
        (0.5, 21.6), 11.0, 1.45,
        boxstyle="round,pad=0.08,rounding_size=0.15",
        facecolor="#1E1B4B", edgecolor="#6366F1", linewidth=2.0, zorder=2
    )
    ax.add_patch(header_box)
    
    # Top Tag Pill
    tag_pill = patches.FancyBboxPatch(
        (4.1, 22.75), 3.8, 0.28,
        boxstyle="round,pad=0.02,rounding_size=0.06",
        facecolor="#4F46E5", edgecolor="#6366F1", linewidth=0.8, zorder=3
    )
    ax.add_patch(tag_pill)
    ax.text(6.0, 22.89, "OPTION C  •  SERVERLESS CI/CD BOT", color=text_white, weight='bold', fontsize=8.8, ha='center', va='center', zorder=4)
    
    ax.text(6.0, 22.38, "CI/CD AUTOMATION BOT & ZERO-TOUCH FLOW", color=text_white, weight='bold', fontsize=16.5, ha='center', zorder=4)
    ax.text(6.0, 21.98, "Codebase-Introspective Hybrid Quality Engine  •  Self-Healing E2E  •  Automated Jira Delivery", color=accent_blue, weight='bold', fontsize=9.2, ha='center', zorder=4)
    ax.text(6.0, 21.74, "Platform Codebase: 0 Lines Added (Strict Read-Only)  |  Idle Cost: $0/month  |  Wakeup: Event-Driven", color=text_muted, fontsize=7.8, ha='center', zorder=4)

    # =========================================================================
    # 2. WHAT BOT WE USE: THE 3 CORE BOT COMPONENTS (y: 19.3 to 21.3)
    # =========================================================================
    sec1_pill = patches.FancyBboxPatch((0.5, 21.25), 4.2, 0.28, boxstyle="round,pad=0.02,rounding_size=0.06", facecolor=accent_blue, edgecolor=accent_blue, zorder=3)
    ax.add_patch(sec1_pill)
    ax.text(0.7, 21.39, "SECTION 1  •  WHAT BOT DO WE USE?", color="#0B0F19", weight='bold', fontsize=8.5, va='center', zorder=4)

    bots = [
        {
            "name": "SERVERLESS RUNNER BOT",
            "tag": "GitHub Actions / GitLab Runner",
            "symbol": "RUNNER",
            "color": accent_indigo,
            "border": "#6366F1",
            "bg": "#1E1B4B",
            "points": [
                "• Completely Serverless in Cloud",
                "• Wakes up in < 5s on events",
                "• Isolated container environment",
                "• Powers down after run (0% CPU)",
                "• Zero local PC / laptop dependency"
            ]
        },
        {
            "name": "SMART DIFF TRIGGER BOT",
            "tag": "Git Webhooks & S3 Watcher",
            "symbol": "TRIGGER",
            "color": accent_emerald,
            "border": "#10B981",
            "bg": "#064E3B",
            "points": [
                "• Wakes on Code Merge or S3 Run",
                "• Executes git diff HEAD~1",
                "• Skips docs/markdown (exits in 3s)",
                "• Identifies impacted tools/routes",
                "• Guarantees targeted test runs"
            ]
        },
        {
            "name": "JIRA CLOUD API BOT",
            "tag": "Jira REST API v3 Integration",
            "symbol": "JIRA BOT",
            "color": accent_purple,
            "border": "#A855F7",
            "bg": "#3B0764",
            "points": [
                "• Automated artifact uploads",
                "• Executive PDF + Excel reports",
                "• Formats native pills [^filename.ext]",
                "• Updates QA tickets automatically",
                "• 100% visible to entire team"
            ]
        }
    ]

    card_w = 3.45
    for i, b in enumerate(bots):
        bx = 0.5 + i * (card_w + 0.32)
        by = 19.3
        card = patches.FancyBboxPatch(
            (bx, by), card_w, 1.85,
            boxstyle="round,pad=0.06,rounding_size=0.1",
            facecolor=card_bg, edgecolor=b["color"], linewidth=1.5, zorder=2
        )
        ax.add_patch(card)
        
        # Header strip inside card
        strip = patches.FancyBboxPatch(
            (bx + 0.08, by + 1.42), card_w - 0.16, 0.34,
            boxstyle="round,pad=0.02,rounding_size=0.06",
            facecolor=b["bg"], edgecolor=b["border"], linewidth=1, zorder=3
        )
        ax.add_patch(strip)
        
        # Badge label
        sbadge = patches.FancyBboxPatch((bx + 0.16, by + 1.47), 0.95, 0.24, boxstyle="round,pad=0.02,rounding_size=0.04", facecolor=b["border"], edgecolor=b["border"], zorder=4)
        ax.add_patch(sbadge)
        ax.text(bx + 0.63, by + 1.59, b["symbol"], color=text_white, weight='bold', fontsize=6.5, ha='center', va='center', zorder=5)
        ax.text(bx + 1.25, by + 1.59, b["name"], color=text_white, weight='bold', fontsize=7.8, va='center', zorder=4)
        
        ax.text(bx + 0.2, by + 1.26, b["tag"], color=b["color"], weight='bold', fontsize=7.2, zorder=4)
        for p_idx, pt in enumerate(b["points"]):
            ax.text(bx + 0.2, by + 1.04 - p_idx * 0.21, pt, color=text_muted, fontsize=6.8, zorder=4)

    # =========================================================================
    # 3. END-TO-END PIPELINE: THE 7-STAGE FLOW (y: 16.7 to 19.0)
    # =========================================================================
    sec2_pill = patches.FancyBboxPatch((0.5, 18.9), 5.5, 0.28, boxstyle="round,pad=0.02,rounding_size=0.06", facecolor=accent_emerald, edgecolor=accent_emerald, zorder=3)
    ax.add_patch(sec2_pill)
    ax.text(0.7, 19.04, "SECTION 2  •  THE 7-STAGE EXECUTION LIFECYCLE", color="#0B0F19", weight='bold', fontsize=8.5, va='center', zorder=4)

    stages = [
        ("1", "TRIGGER", "Push / PR\nor S3 Event", accent_blue, "#0C4A6E"),
        ("2", "WAKE UP", "Runner Boots\nin < 5s", accent_indigo, "#1E1B4B"),
        ("3", "DIFF FILTER", "git diff\nHEAD~1", "#38BDF8", "#164E63"),
        ("4", "SENSORS", "Read AST &\nNext.js Routes", accent_emerald, "#064E3B"),
        ("5", "VALIDATE", "Whitebox +\nSelf-Heal E2E", accent_amber, "#78350F"),
        ("6", "REPORTS", "PDF Review +\nExcel Tracker", accent_purple, "#3B0764"),
        ("7", "JIRA POST", "Upload Pills\nPower Down 0%", accent_rose, "#881337"),
    ]

    stg_w = 1.32
    stg_gap = 0.29
    stg_y = 16.75
    stg_h = 2.0
    
    pipe_outer = patches.FancyBboxPatch(
        (0.5, stg_y), 11.0, stg_h,
        boxstyle="round,pad=0.06,rounding_size=0.12",
        facecolor=card_bg, edgecolor=card_border, linewidth=1.2, zorder=2
    )
    ax.add_patch(pipe_outer)

    for i, (num, title, sub, color, bg) in enumerate(stages):
        sx = 0.7 + i * (stg_w + stg_gap)
        
        scard = patches.FancyBboxPatch(
            (sx, stg_y + 0.35), stg_w, stg_h - 0.45,
            boxstyle="round,pad=0.04,rounding_size=0.08",
            facecolor="#1F2937", edgecolor=color, linewidth=1.5, zorder=3
        )
        ax.add_patch(scard)
        
        # Step Number Badge
        circle = patches.Circle((sx + stg_w/2, stg_y + stg_h - 0.28), 0.22, facecolor=color, edgecolor='white', linewidth=1, zorder=4)
        ax.add_patch(circle)
        ax.text(sx + stg_w/2, stg_y + stg_h - 0.28, num, color='#0B0F19' if color == accent_amber else 'white', weight='bold', fontsize=9.5, ha='center', va='center', zorder=5)
        
        ax.text(sx + stg_w/2, stg_y + stg_h - 0.72, title, color=color, weight='bold', fontsize=7.8, ha='center', zorder=4)
        ax.text(sx + stg_w/2, stg_y + 0.62, sub, color=text_white, fontsize=6.8, linespacing=1.2, ha='center', zorder=4)
        
        # Connecting arrow
        if i < len(stages) - 1:
            ax.annotate(
                '', xy=(sx + stg_w + stg_gap - 0.05, stg_y + stg_h/2 + 0.1), xytext=(sx + stg_w + 0.03, stg_y + stg_h/2 + 0.1),
                arrowprops=dict(arrowstyle="->,head_width=0.3,head_length=0.35", color=text_muted, lw=1.8),
                zorder=4
            )

    pipe_bar = patches.FancyBboxPatch(
        (0.7, stg_y + 0.08), 10.6, 0.22,
        boxstyle="round,pad=0.02,rounding_size=0.04",
        facecolor="#0F172A", edgecolor="#334155", linewidth=0.5, zorder=3
    )
    ax.add_patch(pipe_bar)
    ax.text(6.0, stg_y + 0.19, "✦ 100% Autonomous Execution: 25-35 Seconds Total Duration  •  $0 Idle Cost  •  Zero Human Intervention", color=accent_blue, weight='bold', fontsize=7.2, ha='center', va='center', zorder=4)

    # =========================================================================
    # 4. ZERO-TOUCH CODEBASE ARCHITECTURE & THE 3 SENSORS (y: 13.4 to 16.4)
    # =========================================================================
    sec3_pill = patches.FancyBboxPatch((0.5, 16.45), 5.8, 0.28, boxstyle="round,pad=0.02,rounding_size=0.06", facecolor=accent_rose, edgecolor=accent_rose, zorder=3)
    ax.add_patch(sec3_pill)
    ax.text(0.7, 16.59, "SECTION 3  •  ZERO-TOUCH PLATFORM CODEBASE ARCHITECTURE", color="#0B0F19", weight='bold', fontsize=8.5, va='center', zorder=4)

    zt_y = 13.6
    zt_h = 2.7
    
    # Left Platform Codebase Box
    plat_box = patches.FancyBboxPatch(
        (0.5, zt_y), 3.4, zt_h,
        boxstyle="round,pad=0.06,rounding_size=0.1",
        facecolor="#1C1917", edgecolor=accent_rose, linewidth=1.8, zorder=2
    )
    ax.add_patch(plat_box)
    
    plat_pill = patches.FancyBboxPatch((0.7, zt_y + zt_h - 0.42), 3.0, 0.30, boxstyle="round,pad=0.02,rounding_size=0.05", facecolor=accent_rose, edgecolor=accent_rose, zorder=3)
    ax.add_patch(plat_pill)
    ax.text(2.2, zt_y + zt_h - 0.27, "PLATFORM CODEBASE (READ-ONLY)", color=text_white, weight='bold', fontsize=7.6, ha='center', va='center', zorder=4)
    ax.text(2.2, zt_y + zt_h - 0.62, "F:\\ai-testable-platform", color=accent_amber, fontsize=7.2, ha='center', zorder=4)
    
    plat_pts = [
        "[X]  0 Lines of Code Added",
        "[X]  0 Test Dependencies Installed",
        "[X]  0 Commits or Branches Created",
        "[!]  Mounted 100% Read-Only",
        "[*]  Contains Ground Truth Registries",
        "[*]  Contains Live Next.js App Routes"
    ]
    for idx, p in enumerate(plat_pts):
        ax.text(0.7, zt_y + 1.7 - idx*0.26, p, color=text_white if idx >= 4 else "#FCA5A5", weight='bold' if idx < 4 else 'normal', fontsize=7.0, zorder=4)

    # Middle Sensors Box
    sens_box = patches.FancyBboxPatch(
        (4.2, zt_y), 3.6, zt_h,
        boxstyle="round,pad=0.06,rounding_size=0.1",
        facecolor="#064E3B", edgecolor=accent_emerald, linewidth=1.8, zorder=2
    )
    ax.add_patch(sens_box)
    
    sens_pill = patches.FancyBboxPatch((4.4, zt_y + zt_h - 0.42), 3.2, 0.30, boxstyle="round,pad=0.02,rounding_size=0.05", facecolor=accent_emerald, edgecolor=accent_emerald, zorder=3)
    ax.add_patch(sens_pill)
    ax.text(6.0, zt_y + zt_h - 0.27, "READ-ONLY SENSORS (1-WAY FLOW)", color="#0B0F19", weight='bold', fontsize=7.6, ha='center', va='center', zorder=4)
    
    sens_items = [
        ("Sensor 1: Python AST Tool Reader", "Reads technique_tool.py directly.\nAuto-discovers newly registered tools.", accent_emerald),
        ("Sensor 2: Next.js Route Scanner", "Scans frontend/web-console/src/app/\nMaps live page.tsx URLs automatically.", accent_blue),
        ("Sensor 3: Git-Diff Impact Filter", "Runs git diff HEAD~1 against commit.\nTargets only affected test suites.", accent_amber)
    ]
    for idx, (stitle, sdesc, scolor) in enumerate(sens_items):
        ax.text(4.4, zt_y + 1.85 - idx*0.68, "● " + stitle, color=scolor, weight='bold', fontsize=7.2, zorder=4)
        ax.text(4.65, zt_y + 1.60 - idx*0.68, sdesc, color="#D1FAE5", fontsize=6.6, linespacing=1.2, zorder=4)

    # Right Automation Engine Box
    auto_box = patches.FancyBboxPatch(
        (8.1, zt_y), 3.4, zt_h,
        boxstyle="round,pad=0.06,rounding_size=0.1",
        facecolor="#1E1B4B", edgecolor=accent_indigo, linewidth=1.8, zorder=2
    )
    ax.add_patch(auto_box)
    
    auto_pill = patches.FancyBboxPatch((8.3, zt_y + zt_h - 0.42), 3.0, 0.30, boxstyle="round,pad=0.02,rounding_size=0.05", facecolor=accent_indigo, edgecolor=accent_indigo, zorder=3)
    ax.add_patch(auto_pill)
    ax.text(9.8, zt_y + zt_h - 0.27, "AUTOMATION BOT ENGINE", color=text_white, weight='bold', fontsize=7.6, ha='center', va='center', zorder=4)
    ax.text(9.8, zt_y + zt_h - 0.62, "F:\\Tool Validation Automation", color=accent_blue, fontsize=7.2, ha='center', zorder=4)

    auto_pts = [
        "• Isolated Framework Repository",
        "• Self-Healing Action Resolver",
        "• Playwright Browser Driver",
        "• Multi-Sheet Excel Engine",
        "• Executive 2-Page PDF Builder",
        "• Jira REST API Cloud Poster"
    ]
    for idx, p in enumerate(auto_pts):
        ax.text(8.3, zt_y + 1.7 - idx*0.26, p, color=text_white, fontsize=7.0, zorder=4)

    # 1-Way Data Flow Arrows
    ax.annotate(
        '', xy=(4.15, zt_y + zt_h/2), xytext=(3.95, zt_y + zt_h/2),
        arrowprops=dict(arrowstyle="->,head_width=0.35,head_length=0.4", color=accent_emerald, lw=2.2), zorder=5
    )
    ax.annotate(
        '', xy=(8.05, zt_y + zt_h/2), xytext=(7.85, zt_y + zt_h/2),
        arrowprops=dict(arrowstyle="->,head_width=0.35,head_length=0.4", color=accent_indigo, lw=2.2), zorder=5
    )

    # =========================================================================
    # 5. SMART DECISION TREE: HOW IT KNOWS & WAKES (y: 10.1 to 13.2)
    # =========================================================================
    sec4_pill = patches.FancyBboxPatch((0.5, 13.25), 6.0, 0.28, boxstyle="round,pad=0.02,rounding_size=0.06", facecolor=accent_amber, edgecolor=accent_amber, zorder=3)
    ax.add_patch(sec4_pill)
    ax.text(0.7, 13.39, "SECTION 4  •  SMART GIT-DIFF TRIGGER DECISION TREE", color="#0B0F19", weight='bold', fontsize=8.5, va='center', zorder=4)

    dt_y = 10.35
    dt_h = 2.75
    
    dt_outer = patches.FancyBboxPatch(
        (0.5, dt_y), 11.0, dt_h,
        boxstyle="round,pad=0.06,rounding_size=0.12",
        facecolor=card_bg, edgecolor=card_border, linewidth=1.2, zorder=2
    )
    ax.add_patch(dt_outer)

    # Root Event Box on Left
    root_box = patches.FancyBboxPatch(
        (0.8, dt_y + 0.7), 2.2, 1.35,
        boxstyle="round,pad=0.04,rounding_size=0.08",
        facecolor="#1E1B4B", edgecolor=accent_indigo, linewidth=1.6, zorder=3
    )
    ax.add_patch(root_box)
    ax.text(1.9, dt_y + 1.72, "EVENT FIRED", color=accent_blue, weight='bold', fontsize=8.5, ha='center', zorder=4)
    ax.text(1.9, dt_y + 1.45, "Push / PR Merge / S3", color=text_white, fontsize=7.0, ha='center', zorder=4)
    ax.text(1.9, dt_y + 1.16, "git diff HEAD~1", color=accent_emerald, weight='bold', fontsize=7.8, ha='center', zorder=4)
    ax.text(1.9, dt_y + 0.90, "Inspect Changed Files", color=text_muted, fontsize=6.5, ha='center', zorder=4)

    # Central connector
    ax.plot([3.0, 3.4], [dt_y + 1.38, dt_y + 1.38], color=accent_indigo, lw=2.0, zorder=3)

    # 4 Output Branches
    branches = [
        ("NO-OP", "#64748B", "#1E293B", "Docs / Readme Only (*.md, docs/*, .gitignore)", "Immediate Power-Down (3s)  ➜  Zero tests run · $0 cost", dt_y + 2.05),
        ("WHITEBOX", accent_blue, "#0C4A6E", "Static Tools Modified (shared/scoring/*, tools/*)", "Re-Sync Tool AST  ➜  Execute Whitebox & Taxonomy Parity Validation", dt_y + 1.45),
        ("E2E UI", accent_emerald, "#064E3B", "Frontend Modified (frontend/web-console/*)", "Scan Next.js Routes  ➜  Execute Self-Healing Playwright E2E Tests", dt_y + 0.85),
        ("FULL RUN", accent_amber, "#78350F", "Backend Orchestrator (backend/wb-orchestrator/*)", "Verify Celery Scheduling  ➜  Full End-to-End Regression & Container Validation", dt_y + 0.25),
    ]

    for bname, bcolor, bbg, bmatch, baction, by in branches:
        ax.plot([3.4, 3.7, 4.0], [dt_y + 1.38, by + 0.22, by + 0.22], color=bcolor, lw=1.5, zorder=3)
        ax.annotate(
            '', xy=(4.0, by + 0.22), xytext=(3.7, by + 0.22),
            arrowprops=dict(arrowstyle="->,head_width=0.25,head_length=0.3", color=bcolor, lw=1.5), zorder=3
        )
        
        bcard = patches.FancyBboxPatch(
            (4.05, by), 7.2, 0.44,
            boxstyle="round,pad=0.03,rounding_size=0.06",
            facecolor="#1F2937", edgecolor=bcolor, linewidth=1.2, zorder=3
        )
        ax.add_patch(bcard)
        
        bbadge = patches.FancyBboxPatch(
            (4.15, by + 0.08), 1.15, 0.28,
            boxstyle="round,pad=0.02,rounding_size=0.05",
            facecolor=bcolor, edgecolor=bcolor, zorder=4
        )
        ax.add_patch(bbadge)
        ax.text(4.72, by + 0.22, bname, color='white' if bcolor != accent_amber else '#0B0F19', weight='bold', fontsize=7.2, ha='center', va='center', zorder=5)
        
        ax.text(5.45, by + 0.27, bmatch, color=text_white, weight='bold', fontsize=7.2, zorder=4)
        ax.text(5.45, by + 0.09, baction, color=text_muted, fontsize=6.6, zorder=4)

    # =========================================================================
    # 6. SELF-HEALING UI RESOLVER & BUTTON SHIFT PROTECTION (y: 6.8 to 9.9)
    # =========================================================================
    sec5_pill = patches.FancyBboxPatch((0.5, 9.95), 5.6, 0.28, boxstyle="round,pad=0.02,rounding_size=0.06", facecolor=accent_purple, edgecolor=accent_purple, zorder=3)
    ax.add_patch(sec5_pill)
    ax.text(0.7, 10.09, "SECTION 5  •  SELF-HEALING DYNAMIC UI RESOLUTION ENGINE", color="#0B0F19", weight='bold', fontsize=8.5, va='center', zorder=4)

    sh_y = 6.95
    sh_h = 2.85
    
    heal_cards = [
        {
            "title": "BUTTON RENAMED",
            "tag": "RENAME",
            "eg": "e.g. 'Login' ➜ 'Continue'",
            "mech": "Semantic Intent Engine",
            "desc": "Resolves by universal intent\n(AUTH, TRIGGER, EXPORT).\nMatches synonyms automatically.",
            "color": accent_indigo
        },
        {
            "title": "LOCATION SHIFT",
            "tag": "POSITION",
            "eg": "Moved to Header or Sidebar",
            "mech": "Accessibility DOM Tree",
            "desc": "Zero pixel dependency (no X/Y).\nAuto-scrolls viewport to bring\nelement into clickable view.",
            "color": accent_emerald
        },
        {
            "title": "3-DOTS MENU (...)",
            "tag": "DROPDOWN",
            "eg": "Row Action Dropdown (...)",
            "mech": "Auto-Kebab Unfurler",
            "desc": "Detects hidden button, clicks\nparent row action trigger,\nunfurls menu, and clicks item.",
            "color": accent_amber
        },
        {
            "title": "ICON-ONLY SUBMIT",
            "tag": "ICON ONLY",
            "eg": "Arrow ➜ with Zero Text",
            "mech": "Form Hierarchy Anchor",
            "desc": "Detects active form container\nand targets form button\n[type='submit'] by functional role.",
            "color": accent_rose
        }
    ]

    hc_w = 2.58
    for i, c in enumerate(heal_cards):
        hx = 0.5 + i * (hc_w + 0.22)
        hcard = patches.FancyBboxPatch(
            (hx, sh_y), hc_w, sh_h,
            boxstyle="round,pad=0.06,rounding_size=0.1",
            facecolor=card_bg, edgecolor=c["color"], linewidth=1.5, zorder=2
        )
        ax.add_patch(hcard)
        
        # Header Badge
        hbadge = patches.FancyBboxPatch(
            (hx + 0.1, sh_y + sh_h - 0.45), hc_w - 0.2, 0.35,
            boxstyle="round,pad=0.02,rounding_size=0.06",
            facecolor="#1F2937", edgecolor=c["color"], linewidth=1, zorder=3
        )
        ax.add_patch(hbadge)
        
        # Pill inside header
        tpill = patches.FancyBboxPatch((hx + 0.18, sh_y + sh_h - 0.40), 0.78, 0.25, boxstyle="round,pad=0.02,rounding_size=0.04", facecolor=c["color"], edgecolor=c["color"], zorder=4)
        ax.add_patch(tpill)
        ax.text(hx + 0.57, sh_y + sh_h - 0.27, c["tag"], color='#0B0F19' if c["color"] == accent_amber else 'white', weight='bold', fontsize=5.8, ha='center', va='center', zorder=5)
        ax.text(hx + 1.05, sh_y + sh_h - 0.27, c["title"], color=text_white, weight='bold', fontsize=7.2, va='center', zorder=4)
        
        ax.text(hx + 0.2, sh_y + sh_h - 0.72, c["eg"], color=c["color"], weight='bold', fontsize=7.0, zorder=4)
        ax.text(hx + 0.2, sh_y + sh_h - 1.02, "Mechanism:", color=text_muted, fontsize=6.5, zorder=4)
        ax.text(hx + 0.2, sh_y + sh_h - 1.25, c["mech"], color=text_white, weight='bold', fontsize=7.0, zorder=4)
        ax.text(hx + 0.2, sh_y + 0.55, c["desc"], color=text_muted, fontsize=6.6, linespacing=1.3, zorder=4)

    # =========================================================================
    # 7. TEAM COLLABORATION MODEL: WHO DOES WHAT? (y: 3.5 to 6.5)
    # =========================================================================
    sec6_pill = patches.FancyBboxPatch((0.5, 6.55), 5.4, 0.28, boxstyle="round,pad=0.02,rounding_size=0.06", facecolor=accent_blue, edgecolor=accent_blue, zorder=3)
    ax.add_patch(sec6_pill)
    ax.text(0.7, 6.69, "SECTION 6  •  HOW THE ENTIRE TEAM COLLABORATES", color="#0B0F19", weight='bold', fontsize=8.5, va='center', zorder=4)

    roles = [
        {
            "role": "DEVELOPERS",
            "tag": "DEV TEAM",
            "badge": "0 Script Installation",
            "color": accent_indigo,
            "actions": [
                "• Push code or open PRs normally",
                "• Bot validates static tools automatically",
                "• Receives instant PR status checks",
                "• Clear root-cause attribution on failure"
            ]
        },
        {
            "role": "QA ENGINEERS",
            "tag": "QA TEAM",
            "badge": "0 Code Scripting",
            "color": accent_emerald,
            "actions": [
                "• Add E2E tests in Excel (testcases/admin.xlsx)",
                "• Zero python/playwright coding required",
                "• Inspect container defect classification",
                "• Verify taxonomy parity gates effortlessly"
            ]
        },
        {
            "role": "LEADERSHIP / MANAGERS",
            "tag": "LEADERSHIP",
            "badge": "1-Click Executive Delivery",
            "color": accent_amber,
            "actions": [
                "• Jira tickets updated with 2-page review PDFs",
                "• Excel matrices attached with native pills",
                "• 30-second executive BLUF summary",
                "• Saravanan / Rathiba / Benny QA standard"
            ]
        }
    ]

    rc_w = 3.45
    for i, r in enumerate(roles):
        rx = 0.5 + i * (rc_w + 0.32)
        ry = 3.75
        rcard = patches.FancyBboxPatch(
            (rx, ry), rc_w, 2.65,
            boxstyle="round,pad=0.06,rounding_size=0.1",
            facecolor=card_bg, edgecolor=r["color"], linewidth=1.5, zorder=2
        )
        ax.add_patch(rcard)
        
        # Header Badge
        rbadge = patches.FancyBboxPatch(
            (rx + 0.1, ry + 2.15), rc_w - 0.2, 0.38,
            boxstyle="round,pad=0.02,rounding_size=0.06",
            facecolor="#1F2937", edgecolor=r["color"], linewidth=1, zorder=3
        )
        ax.add_patch(rbadge)
        
        rpill = patches.FancyBboxPatch((rx + 0.18, ry + 2.22), 0.95, 0.24, boxstyle="round,pad=0.02,rounding_size=0.04", facecolor=r["color"], edgecolor=r["color"], zorder=4)
        ax.add_patch(rpill)
        ax.text(rx + 0.65, ry + 2.34, r["tag"], color='#0B0F19' if r["color"] == accent_amber else 'white', weight='bold', fontsize=6.2, ha='center', va='center', zorder=5)
        ax.text(rx + 1.25, ry + 2.34, r["role"], color=text_white, weight='bold', fontsize=8.0, va='center', zorder=4)
        
        ax.text(rx + 0.2, ry + 1.88, "Benefit: " + r["badge"], color=r["color"], weight='bold', fontsize=7.2, zorder=4)
        for a_idx, act in enumerate(r["actions"]):
            ax.text(rx + 0.2, ry + 1.55 - a_idx*0.28, act, color=text_white, fontsize=6.8, zorder=4)

    # =========================================================================
    # 8. SIGN-OFF FOOTER BANNER (y: 0.5 to 3.3)
    # =========================================================================
    footer_box = patches.FancyBboxPatch(
        (0.5, 0.5), 11.0, 2.75,
        boxstyle="round,pad=0.08,rounding_size=0.12",
        facecolor="#0F172A", edgecolor=accent_emerald, linewidth=1.8, zorder=2
    )
    ax.add_patch(footer_box)
    
    foot_pill = patches.FancyBboxPatch((4.0, 2.95), 4.0, 0.28, boxstyle="round,pad=0.02,rounding_size=0.05", facecolor=accent_emerald, edgecolor=accent_emerald, zorder=3)
    ax.add_patch(foot_pill)
    ax.text(6.0, 3.09, "EXECUTIVE QA ARCHITECTURE SIGN-OFF", color="#0B0F19", weight='bold', fontsize=8.5, ha='center', va='center', zorder=4)
    
    ax.text(6.0, 2.60, "SARAVANAN SELVARAJ  •  RATHIBA  •  BENNY QA STANDARD COMPLIANCE", color=text_white, weight='bold', fontsize=9.6, ha='center', zorder=4)
    
    bullets = [
        "✓  100% Non-Destructive Safety: Platform repository is strictly Read-Only. 0 code changes, 0 dependencies, 0 commits.",
        "✓  Zero Maintenance Overhead: Self-healing semantic actions & AST introspection adapt to UI & tool changes automatically.",
        "✓  True Serverless Architecture: GitHub Actions runs on-demand for ~30 seconds with $0 idle cost and 0% CPU consumption.",
        "✓  Automated Jira Cloud Delivery: Native pills [^filename.ext] with clickable reports, executive PDFs, and Excel trackers."
    ]
    for b_idx, btext in enumerate(bullets):
        ax.text(1.0, 2.15 - b_idx * 0.32, btext, color="#CBD5E1", fontsize=7.2, zorder=4)

    ax.text(6.0, 0.72, "Confidential  •  Testable Quality Engineering  •  Tool Validation Automation Repository", color="#64748B", fontsize=6.8, ha='center', zorder=4)

    # Save PNG Infographic
    plt.savefig(PNG_POSTER, dpi=300, bbox_inches='tight', pad_inches=0.1)
    # Save PDF Poster
    plt.savefig(PDF_POSTER, dpi=300, bbox_inches='tight', pad_inches=0.1)
    plt.close()
    
    print(f"Generated High-Impact PNG Poster: {PNG_POSTER}")
    print(f"Generated High-Impact PDF Poster: {PDF_POSTER}")
    
    # Copy to Downloads
    shutil.copy2(PNG_POSTER, DOWNLOADS_PNG)
    shutil.copy2(PDF_POSTER, DOWNLOADS_PDF)
    print(f"Copied to Downloads: {DOWNLOADS_PNG}")
    print(f"Copied to Downloads: {DOWNLOADS_PDF}")


if __name__ == "__main__":
    draw_poster()
