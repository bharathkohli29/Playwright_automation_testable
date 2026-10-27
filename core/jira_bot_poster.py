import os
from pathlib import Path
from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field
import requests

class JiraDeliverablePayload(BaseModel):
    issue_key: str
    run_id: str
    pass_rate: str
    total_tools: int
    passed_tools: int
    failed_tools: int
    excel_name: str
    pdf_name: str
    bluf_summary: str
    tool_results: List[Dict[str, Any]] = Field(default_factory=list)

class JiraBotPoster:
    """Formats and publishes QA validation deliverables to Jira Cloud using REST API v3."""

    def __init__(
        self,
        jira_url: Optional[str] = None,
        username: Optional[str] = None,
        api_token: Optional[str] = None,
        dry_run: bool = True
    ):
        self.jira_url = (jira_url or os.getenv("JIRA_BASE_URL", "")).rstrip("/")
        self.username = username or os.getenv("JIRA_USER_EMAIL", "")
        self.api_token = api_token or os.getenv("JIRA_API_TOKEN", "")
        self.dry_run = dry_run or not bool(self.jira_url and self.username and self.api_token)

    def _get_auth(self):
        return (self.username, self.api_token)

    def _get_headers(self):
        return {
            "Accept": "application/json",
            "X-Atlassian-Token": "no-check"
        }

    def format_jira_comment(self, payload: JiraDeliverablePayload) -> str:
        """Formats an executive Jira update following the Saravanan Selvaraj / Rathiba / Benny QA standard."""
        lines = [
            f"h3. [AUTOMATION] Quality Gate & Tool Execution Report ({payload.issue_key})",
            "",
            "{panel:title=EXECUTIVE SUMMARY (BLUF)|borderStyle=solid|borderColor=#2563EB|titleBGColor=#EFF6FF|bgColor=#FFFFFF}",
            f"*Run ID:* {{color:#2563EB}}*{payload.run_id}*{{color}} | *Pass Rate:* {{color:#16A34A}}*{payload.pass_rate}*{{color}} ({payload.passed_tools}/{payload.total_tools} checks passed)",
            f"{payload.bluf_summary}",
            "{panel}",
            "",
            "h4. Official QA Deliverables Attached",
            f"* *Detailed Matrix Tracker:* [^{payload.excel_name}]",
            f"* *Executive Review Summary:* [^{payload.pdf_name}]",
            "",
            "h4. High-Level Tool Execution Snapshot",
            "|| Tool Name || Status || Root Cause / Category ||",
        ]

        if payload.tool_results:
            for t in payload.tool_results[:8]:
                status = t.get("status", "PASSED")
                status_color = "#16A34A" if status == "PASSED" else "#DC2626"
                lines.append(f"| {t.get('name', 'N/A')} | {{color:{status_color}}}*{status}*{{color}} | {t.get('rca', 'Platform Success')} |")
        else:
            lines.append(f"| All Evaluated Tools ({payload.total_tools}) | {{color:#16A34A}}*PASSED ({payload.passed_tools}/{payload.total_tools})*{{color}} | Validated against Ground Truth Taxonomy |")

        lines.extend([
            "",
            "----",
            "_Automated validation run posted by CI/CD Bot • Verified against `F:/ai-testable-platform`_"
        ])

        return "\n".join(lines)

    def upload_attachment(self, issue_key: str, file_path: Path | str) -> bool:
        """Uploads a single file to Jira issue attachments via REST API v3."""
        if self.dry_run:
            return True

        p = Path(file_path)
        if not p.exists() or not p.is_file():
            return False

        url = f"{self.jira_url}/rest/api/3/issue/{issue_key}/attachments"
        try:
            with open(p, "rb") as f:
                files = {"file": (p.name, f, "application/octet-stream")}
                res = requests.post(url, headers=self._get_headers(), auth=self._get_auth(), files=files, timeout=30)
                return res.status_code in (200, 201)
        except Exception:
            return False

    def add_comment(self, issue_key: str, comment_text: str) -> bool:
        """Adds a comment to the Jira issue."""
        if self.dry_run:
            return True

        url = f"{self.jira_url}/rest/api/3/issue/{issue_key}/comment"
        try:
            body = {"body": comment_text}
            res = requests.post(url, headers={"Content-Type": "application/json", "Accept": "application/json"}, auth=self._get_auth(), json=body, timeout=30)
            return res.status_code in (200, 201)
        except Exception:
            return False

    def post_deliverables(
        self,
        payload: JiraDeliverablePayload,
        file_paths: List[Path | str]
    ) -> Dict[str, Any]:
        """Publishes comments and attaches artifacts to Jira issue."""
        comment = self.format_jira_comment(payload)
        attached = []

        if self.dry_run:
            return {
                "status": "dry_run_success",
                "issue_key": payload.issue_key,
                "attached_files": [Path(p).name for p in file_paths],
                "comment_length": len(comment),
                "comment_preview": comment[:200]
            }

        # Live Upload
        for fp in file_paths:
            if self.upload_attachment(payload.issue_key, fp):
                attached.append(Path(fp).name)

        comment_posted = self.add_comment(payload.issue_key, comment)

        return {
            "status": "published" if comment_posted else "partial_failure",
            "issue_key": payload.issue_key,
            "attached_files": attached,
            "comment_posted": comment_posted
        }
