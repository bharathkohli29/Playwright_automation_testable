import os
from pathlib import Path
import matplotlib.pyplot as plt
import matplotlib.patches as patches

# Configure Matplotlib styling
plt.rcParams['font.sans-serif'] = ['DejaVu Sans', 'Arial', 'Calibri', 'Helvetica']
plt.rcParams['axes.edgecolor'] = '#CBD5E1'
plt.rcParams['axes.linewidth'] = 0.8

OUTPUT_DIR = Path("f:/Tool Validation Automation/assets/diagrams")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def create_pipeline_flow_diagram():
    """Generates the 7-stage End-to-End Serverless CI/CD Bot Pipeline Flow."""
    fig, ax = plt.subplots(figsize=(11, 3.2), dpi=300)
    ax.set_facecolor('#F8FAFC')
    fig.patch.set_facecolor('#F8FAFC')
    
    stages = [
        {"num": "1", "title": "TRIGGER EVENT", "sub": "Code Push / PR\nor S3 Run Event", "color": "#2563EB", "bg": "#EFF6FF"},
        {"num": "2", "title": "BOT WAKES UP", "sub": "GitHub Runner\nSpins Up (< 5s)", "color": "#4F46E5", "bg": "#EEF2FF"},
        {"num": "3", "title": "DIFF FILTER", "sub": "git diff HEAD~1\nImpact Analyzer", "color": "#0284C7", "bg": "#F0F9FF"},
        {"num": "4", "title": "INTROSPECTION", "sub": "Read-Only AST &\nNext.js Routes", "color": "#0D9488", "bg": "#F0FDFA"},
        {"num": "5", "title": "TARGETED RUN", "sub": "Whitebox Tools +\nSelf-Healing E2E", "color": "#16A34A", "bg": "#F0FDF4"},
        {"num": "6", "title": "REPORTS BUILT", "sub": "Excel Tracker +\nExecutive PDF", "color": "#D97706", "bg": "#FFFBEB"},
        {"num": "7", "title": "JIRA & SHUTDOWN", "sub": "Upload Pills [^file]\nPowers Down (0%)", "color": "#7C3AED", "bg": "#F5F3FF"},
    ]
    
    n = len(stages)
    box_w = 1.15
    box_h = 1.7
    spacing = 0.38
    start_x = 0.35
    y_pos = 0.75
    
    for i, s in enumerate(stages):
        x = start_x + i * (box_w + spacing)
        
        # Outer Card Box
        card = patches.FancyBboxPatch(
            (x, y_pos), box_w, box_h,
            boxstyle="round,pad=0.08,rounding_size=0.1",
            facecolor=s["bg"],
            edgecolor=s["color"],
            linewidth=1.8,
            zorder=3
        )
        ax.add_patch(card)
        
        # Step Number Badge
        badge = patches.Circle(
            (x + box_w/2, y_pos + box_h - 0.05), 0.18,
            facecolor=s["color"],
            edgecolor='white',
            linewidth=1.5,
            zorder=4
        )
        ax.add_patch(badge)
        ax.text(
            x + box_w/2, y_pos + box_h - 0.05, s["num"],
            color='white', weight='bold', fontsize=9,
            ha='center', va='center', zorder=5
        )
        
        # Title
        ax.text(
            x + box_w/2, y_pos + box_h - 0.52, s["title"],
            color=s["color"], weight='bold', fontsize=8,
            ha='center', va='center', zorder=4
        )
        
        # Subtitle
        ax.text(
            x + box_w/2, y_pos + 0.52, s["sub"],
            color='#334155', fontsize=6.8, linespacing=1.25,
            ha='center', va='center', zorder=4
        )
        
        # Arrow to next stage
        if i < n - 1:
            arr_x = x + box_w + 0.04
            arr_y = y_pos + box_h / 2
            ax.annotate(
                '', xy=(arr_x + spacing - 0.08, arr_y), xytext=(arr_x, arr_y),
                arrowprops=dict(
                    arrowstyle="->,head_width=0.35,head_length=0.4",
                    color="#94A3B8",
                    lw=2.0
                ),
                zorder=2
            )
            
    # Bottom Summary Bar
    bar_patch = patches.FancyBboxPatch(
        (start_x, 0.15), n * (box_w + spacing) - spacing + 0.05, 0.35,
        boxstyle="round,pad=0.04,rounding_size=0.08",
        facecolor='#1E293B',
        edgecolor='#0F172A',
        linewidth=1,
        zorder=3
    )
    ax.add_patch(bar_patch)
    ax.text(
        start_x + (n * (box_w + spacing) - spacing + 0.05)/2, 0.32,
        "Zero Idle Cost ($0/month)  •  Completely Serverless  •  No Local Machine Required  •  Automatic Power Down",
        color='#38BDF8', weight='bold', fontsize=7.2,
        ha='center', va='center', zorder=4
    )
    
    ax.set_xlim(0, start_x + n * (box_w + spacing) - spacing + 0.4)
    ax.set_ylim(0, 2.7)
    ax.axis('off')
    
    out_file = OUTPUT_DIR / "pipeline_flow.png"
    plt.tight_layout()
    plt.savefig(out_file, dpi=300, bbox_inches='tight', pad_inches=0.05)
    plt.close()
    print(f"Generated: {out_file}")


def create_zero_touch_diagram():
    """Generates the Zero-Touch Platform Codebase vs External Automation Architecture Diagram."""
    fig, ax = plt.subplots(figsize=(10, 3.4), dpi=300)
    ax.set_facecolor('#F8FAFC')
    fig.patch.set_facecolor('#F8FAFC')
    
    # Left Box: Platform Codebase (Strictly Read-Only)
    left_card = patches.FancyBboxPatch(
        (0.3, 0.3), 2.8, 2.5,
        boxstyle="round,pad=0.08,rounding_size=0.12",
        facecolor="#FEF2F2",
        edgecolor="#EF4444",
        linewidth=1.8,
        zorder=3
    )
    ax.add_patch(left_card)
    ax.text(1.7, 2.58, "PLATFORM CODEBASE", color="#B91C1C", weight='bold', fontsize=9.2, ha='center', zorder=5)
    ax.text(1.7, 2.36, "(F:\\ai-testable-platform)", color="#7F1D1D", fontsize=7.2, ha='center', zorder=5)
    
    # Left Box Badge
    badge_l = patches.FancyBboxPatch(
        (0.5, 1.95), 2.4, 0.28,
        boxstyle="round,pad=0.02,rounding_size=0.06",
        facecolor="#DC2626", edgecolor="#991B1B", linewidth=0.5,
        zorder=4
    )
    ax.add_patch(badge_l)
    ax.text(1.7, 2.09, "STRICTLY 100% READ-ONLY", color='white', weight='bold', fontsize=7.2, ha='center', va='center', zorder=5)
    
    left_items = [
        "• 0 Code Changes Added",
        "• 0 Test Dependencies Installed",
        "• 0 Commits or Branch Dirtying",
        "• Ground-Truth Tool Registry",
        "• Next.js App Router Tree",
    ]
    for idx, item in enumerate(left_items):
        ax.text(0.5, 1.65 - idx*0.25, item, color="#450A0A", fontsize=7.0, zorder=5)
        
    # Center Connector: Read-Only Sensors (One-Way Data Flow)
    sensor_card = patches.FancyBboxPatch(
        (3.6, 0.4), 2.6, 2.3,
        boxstyle="round,pad=0.06,rounding_size=0.1",
        facecolor="#F0FDF4",
        edgecolor="#16A34A",
        linewidth=1.8,
        zorder=3
    )
    ax.add_patch(sensor_card)
    ax.text(4.9, 2.45, "READ-ONLY SENSORS", color="#15803D", weight='bold', fontsize=8.8, ha='center', zorder=5)
    ax.text(4.9, 2.24, "One-Way Inspection (No Edits)", color="#166534", fontsize=7.0, ha='center', zorder=5)
    
    sensor_items = [
        "1. Python AST Tool Parser",
        "   Reads technique_tool.py",
        "2. Next.js Route Scanner",
        "   Maps live page.tsx paths",
        "3. Git Diff Impact Filter",
        "   Inspects HEAD~1 diffs"
    ]
    for idx, item in enumerate(sensor_items):
        is_sub = item.startswith("   ")
        color = "#14532D" if is_sub else "#0F172A"
        weight = 'normal' if is_sub else 'bold'
        ax.text(3.8, 1.88 - idx*0.23, item, color=color, weight=weight, fontsize=6.8, zorder=5)
        
    # Arrows: Left to Center (One-Way)
    ax.annotate(
        '', xy=(3.55, 1.55), xytext=(3.15, 1.55),
        arrowprops=dict(arrowstyle="->,head_width=0.35,head_length=0.4", color="#16A34A", lw=2.2),
        zorder=6
    )
    ax.text(3.35, 1.72, "Read Only", color="#16A34A", weight='bold', fontsize=6.8, ha='center', zorder=7)

    # Right Box: Automation Repository (F:\Tool Validation Automation)
    right_card = patches.FancyBboxPatch(
        (6.7, 0.3), 3.0, 2.5,
        boxstyle="round,pad=0.08,rounding_size=0.12",
        facecolor="#EFF6FF",
        edgecolor="#2563EB",
        linewidth=1.8,
        zorder=3
    )
    ax.add_patch(right_card)
    ax.text(8.2, 2.58, "AUTOMATION BOT ENGINE", color="#1E40AF", weight='bold', fontsize=9.2, ha='center', zorder=5)
    ax.text(8.2, 2.36, "(F:\\Tool Validation Automation)", color="#1E3A8A", fontsize=7.2, ha='center', zorder=5)
    
    badge_r = patches.FancyBboxPatch(
        (6.9, 1.95), 2.6, 0.28,
        boxstyle="round,pad=0.02,rounding_size=0.06",
        facecolor="#2563EB", edgecolor="#1D4ED8", linewidth=0.5,
        zorder=4
    )
    ax.add_patch(badge_r)
    ax.text(8.2, 2.09, "ISOLATED AUTOMATION HOME", color='white', weight='bold', fontsize=7.2, ha='center', va='center', zorder=5)
    
    right_items = [
        "• Self-Healing Action Resolver",
        "• Playwright E2E Driver",
        "• Whitebox & RCA Classifier",
        "• Multi-Sheet Excel Engine",
        "• Executive 2-Page PDF Builder",
        "• Jira REST API Cloud Poster"
    ]
    for idx, item in enumerate(right_items):
        ax.text(7.0, 1.68 - idx*0.22, item, color="#1E293B", fontsize=7.0, zorder=5)
        
    # Arrows: Center to Right
    ax.annotate(
        '', xy=(6.65, 1.55), xytext=(6.25, 1.55),
        arrowprops=dict(arrowstyle="->,head_width=0.35,head_length=0.4", color="#2563EB", lw=2.2),
        zorder=6
    )
    ax.text(6.45, 1.72, "Feeds Data", color="#2563EB", weight='bold', fontsize=6.8, ha='center', zorder=7)

    ax.set_xlim(0, 10.0)
    ax.set_ylim(0, 3.0)
    ax.axis('off')
    
    out_file = OUTPUT_DIR / "zero_touch_architecture.png"
    plt.tight_layout()
    plt.savefig(out_file, dpi=300, bbox_inches='tight', pad_inches=0.05)
    plt.close()
    print(f"Generated: {out_file}")


def create_decision_tree_diagram():
    """Generates the Smart Git-Diff Trigger Filter & Execution Decision Tree Diagram."""
    fig, ax = plt.subplots(figsize=(10.5, 3.2), dpi=300)
    ax.set_facecolor('#F8FAFC')
    fig.patch.set_facecolor('#F8FAFC')
    
    # Root: Incoming Trigger
    root_box = patches.FancyBboxPatch(
        (0.3, 1.0), 2.2, 1.0,
        boxstyle="round,pad=0.06,rounding_size=0.1",
        facecolor="#EEF2FF",
        edgecolor="#4F46E5",
        linewidth=1.8,
        zorder=3
    )
    ax.add_patch(root_box)
    ax.text(1.4, 1.68, "EVENT RECEIVED", color="#4338CA", weight='bold', fontsize=8.2, ha='center', zorder=5)
    ax.text(1.4, 1.42, "GitHub Push / PR / S3", color="#312E81", fontsize=7.0, ha='center', zorder=5)
    ax.text(1.4, 1.18, "git diff HEAD~1", color="#6366F1", weight='bold', fontsize=7.2, ha='center', zorder=5)
    
    # Central Branching Point
    ax.annotate(
        '', xy=(3.2, 1.5), xytext=(2.55, 1.5),
        arrowprops=dict(arrowstyle="->,head_width=0.3,head_length=0.35", color="#4F46E5", lw=2.0),
        zorder=2
    )
    
    # 4 Output Paths
    paths = [
        {
            "y": 2.2,
            "title": "Docs / Readmes Only",
            "rule": "*.md, docs/*, .gitignore",
            "action": "Immediate Power-Down (3s)",
            "result": "Zero tests run · $0 cost",
            "color": "#64748B", "bg": "#F1F5F9", "badge": "NO-OP"
        },
        {
            "y": 1.5,
            "title": "Static Tools Modified",
            "rule": "shared/scoring/*, tools/*",
            "action": "Re-Sync Tool Registry AST",
            "result": "Run Whitebox & Taxonomy Validation",
            "color": "#0284C7", "bg": "#F0F9FF", "badge": "WHITEBOX"
        },
        {
            "y": 0.8,
            "title": "Frontend UI Modified",
            "rule": "frontend/web-console/*",
            "action": "Scan Next.js page.tsx Routes",
            "result": "Run Self-Healing Playwright E2E",
            "color": "#16A34A", "bg": "#F0FDF4", "badge": "E2E UI"
        },
        {
            "y": 0.1,
            "title": "Backend / Orchestrator",
            "rule": "backend/wb-orchestrator/*",
            "action": "Verify Celery Task Scheduling",
            "result": "Run Full E2E & Container Verification",
            "color": "#D97706", "bg": "#FFFBEB", "badge": "FULL RUN"
        }
    ]
    
    for p in paths:
        # Connecting lines
        ax.plot([3.2, 3.5, 3.8], [1.5, p["y"] + 0.3, p["y"] + 0.3], color=p["color"], lw=1.5, zorder=2)
        ax.annotate(
            '', xy=(3.8, p["y"] + 0.3), xytext=(3.5, p["y"] + 0.3),
            arrowprops=dict(arrowstyle="->,head_width=0.25,head_length=0.3", color=p["color"], lw=1.5),
            zorder=2
        )
        
        # Branch Card
        card = patches.FancyBboxPatch(
            (3.85, p["y"]), 6.2, 0.58,
            boxstyle="round,pad=0.04,rounding_size=0.06",
            facecolor=p["bg"],
            edgecolor=p["color"],
            linewidth=1.2,
            zorder=3
        )
        ax.add_patch(card)
        
        # Badge with explicit zorder and centered text
        badge = patches.FancyBboxPatch(
            (3.95, p["y"] + 0.12), 1.15, 0.34,
            boxstyle="round,pad=0.02,rounding_size=0.06",
            facecolor=p["color"],
            edgecolor=p["color"],
            linewidth=0.5,
            zorder=4
        )
        ax.add_patch(badge)
        ax.text(
            4.52, p["y"] + 0.29, p["badge"],
            color='white', weight='bold', fontsize=7.2,
            ha='center', va='center', zorder=6
        )
        
        # Text details
        ax.text(5.25, p["y"] + 0.38, f"{p['title']} ({p['rule']})", color="#0F172A", weight='bold', fontsize=7.4, zorder=5)
        ax.text(5.25, p["y"] + 0.14, f"Action: {p['action']}  ➜  Outcome: {p['result']}", color="#334155", fontsize=6.8, zorder=5)

    ax.set_xlim(0, 10.4)
    ax.set_ylim(-0.1, 3.0)
    ax.axis('off')
    
    out_file = OUTPUT_DIR / "bot_decision_tree.png"
    plt.tight_layout()
    plt.savefig(out_file, dpi=300, bbox_inches='tight', pad_inches=0.05)
    plt.close()
    print(f"Generated: {out_file}")


if __name__ == "__main__":
    create_pipeline_flow_diagram()
    create_zero_touch_diagram()
    create_decision_tree_diagram()
    print("All architecture diagrams created successfully in assets/diagrams/")
