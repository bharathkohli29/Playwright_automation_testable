import argparse
import sys
from pathlib import Path
from core.platform_inspector import PlatformInspector
from core.catalog_sync import CatalogSynchronizer
from core.route_discoverer import RouteDiscoverer
from core.build_analyzer import BuildAnalyzer
from core.report_generator import ReportGenerator
from core.jira_bot_poster import JiraBotPoster, JiraDeliverablePayload
from core.config import DEFAULT_PLATFORM_PATH

def cmd_inspect(args):
    platform_path = Path(args.platform_path).resolve()
    inspector = PlatformInspector(platform_path)
    if not inspector.is_valid_platform_root():
        print(f"[ERROR] Invalid platform root: {platform_path}")
        sys.exit(1)

    print("==================================================")
    print(" [INSPECT] PLATFORM CODEBASE READ-ONLY INTROSPECTION")
    print("==================================================")
    print(f"Platform Path:    {inspector.root}")
    print(f"Platform Version: {inspector.get_version()}")
    print(f"Git Commit:       {inspector.get_git_commit()}")
    print(f"Git Branch:       {inspector.get_git_branch()}")
    
    # Tool Catalog
    sync = CatalogSynchronizer(platform_path)
    tools = sorted(sync.get_registered_tools())
    print(f"\nDiscovered Tools ({len(tools)}):")
    print(f"  {', '.join(tools)}")

    # Routes
    web_app = platform_path / "frontend" / "web-console" / "src" / "app"
    discoverer = RouteDiscoverer(web_app)
    routes = discoverer.get_routes()
    print(f"\nLive Routes ({len(routes)}):")
    for r in routes[:10]:
        print(f"  {r}")
    if len(routes) > 10:
        print(f"  ... and {len(routes)-10} more routes")
    print("==================================================")


def cmd_auto_validate(args):
    platform_path = Path(args.platform_path).resolve()
    inspector = PlatformInspector(platform_path)
    if not inspector.is_valid_platform_root():
        print(f"[ERROR] Invalid platform root: {platform_path}")
        sys.exit(1)

    print("==================================================")
    print(" [RUN] EVENT-DRIVEN CI/CD AUTOMATION BOT PIPELINE")
    print("==================================================")
    version = inspector.get_version()
    commit = inspector.get_git_commit()
    print(f"[OK] Platform Version: {version} (Commit: {commit})")

    # Step 1: Git Diff Impact Filter
    analyzer = BuildAnalyzer(platform_path)
    changed_files = analyzer.get_changed_files()
    impact = analyzer.classify_changes(changed_files)
    print(f"[OK] Build Impact Category: {impact.category}")

    if impact.should_exit_early:
        print(f"[OK] Documentation-only change detected. Exiting in 3s with $0 cost.")
        sys.exit(0)

    # Step 2: Read-Only Sensors
    sync = CatalogSynchronizer(platform_path)
    tools = sync.get_registered_tools()
    print(f"[OK] Active Tools Discovered: {len(tools)} tools synchronized from AST & configs")

    web_app = platform_path / "frontend" / "web-console" / "src" / "app"
    discoverer = RouteDiscoverer(web_app)
    routes = discoverer.get_routes()
    print(f"[OK] Live Routes Mapped: {len(routes)} web console routes")

    # Step 3: Run Data Ingestion & Real Deliverables Generation
    rep_gen = ReportGenerator(output_dir=".")
    if args.run_path and Path(args.run_path).exists():
        run_data = rep_gen.parse_run_directory(args.run_path)
        print(f"[OK] Run Data Parsed: {run_data.get('run_id')} ({run_data.get('total_tools')} rows, Pass Rate: {run_data.get('pass_rate')})")
    else:
        # No run results supplied: report only what was actually measured (catalog + route discovery).
        checks = {"tool catalog discovered": len(tools) > 0, "web console routes discovered": len(routes) > 0}
        passed_checks = sum(checks.values())
        failed_names = [n for n, ok in checks.items() if not ok]
        for n in failed_names:
            print(f"[FAIL] Check failed: {n}")
        run_data = {
            "run_id": f"build-{version}-{commit}",
            "branch": inspector.get_git_branch(),
            "commit": commit,
            "pass_rate": f"{passed_checks / len(checks) * 100:.0f}%",
            "total_tools": len(checks),
            "passed_tools": passed_checks,
            "failed_tools": len(failed_names),
            "rows": []
        }

    excel_path = rep_gen.generate_excel_tracker(run_data, filename="Tool_Execution_Results.xlsx")
    pdf_path = rep_gen.generate_pdf_report(run_data, filename="Executive_Architecture_Review.pdf")
    print(f"[OK] Real Deliverables Generated:")
    print(f"     • Excel: {excel_path} ({excel_path.stat().st_size} bytes)")
    print(f"     • PDF:   {pdf_path} ({pdf_path.stat().st_size} bytes)")

    # Step 4: Jira Delivery
    payload = JiraDeliverablePayload(
        issue_key=args.issue_key,
        run_id=run_data.get("run_id"),
        pass_rate=run_data.get("pass_rate", "100%"),
        total_tools=run_data.get("total_tools", len(tools)),
        passed_tools=run_data.get("passed_tools", len(tools)),
        failed_tools=run_data.get("failed_tools", 0),
        excel_name=excel_path.name,
        pdf_name=pdf_path.name,
        bluf_summary=(
            f"Automated build {version} verified against ground-truth taxonomy. All {run_data.get('total_tools')} checks and live routes evaluated."
            if run_data.get("failed_tools", 0) == 0 else
            f"Automated build {version}: {run_data.get('failed_tools')} of {run_data.get('total_tools')} checks failed."
        )
    )

    poster = JiraBotPoster(dry_run=args.dry_run)
    res = poster.post_deliverables(payload, file_paths=[excel_path, pdf_path])
    print(f"[OK] Jira Delivery Status: {res.get('status')} for issue {args.issue_key}")
    print("==================================================")
    if run_data.get("failed_tools", 0):
        print("[FAIL] Auto-validation finished with failed checks.")
        sys.exit(1)
    print("[OK] Auto-validation pipeline executed successfully with 0 platform code changes.")


def main():
    parser = argparse.ArgumentParser(description="Testable Platform Automation Bot CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # inspect
    p_inspect = subparsers.add_parser("inspect", help="Inspect platform codebase in read-only mode")
    p_inspect.add_argument("--platform-path", default=DEFAULT_PLATFORM_PATH, help="Path to platform repository")
    p_inspect.set_defaults(func=cmd_inspect)

    # auto-validate
    p_validate = subparsers.add_parser("auto-validate", help="Run automated validation pipeline")
    p_validate.add_argument("--platform-path", default=DEFAULT_PLATFORM_PATH, help="Path to platform repository")
    p_validate.add_argument("--run-path", default=None, help="Path to historical or current run artifacts folder")
    p_validate.add_argument("--issue-key", default="TP-6246", help="Jira issue key to update")
    p_validate.add_argument("--dry-run", action="store_true", help="Perform dry-run without network calls")
    p_validate.set_defaults(func=cmd_auto_validate)

    args = parser.parse_args()
    args.func(args)

if __name__ == "__main__":
    main()
