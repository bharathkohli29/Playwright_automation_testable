import pytest
from pathlib import Path
from core.report_generator import ReportGenerator

def test_report_generator_mock(tmp_path):
    gen = ReportGenerator(output_dir=tmp_path)
    run_data = {
        "run_id": "test-run-123",
        "branch": "main",
        "commit": "abc1234",
        "pass_rate": "95.0%",
        "total_tools": 20,
        "passed_tools": 19,
        "failed_tools": 1,
        "not_applicable": 0,
        "rows": [
            {"tt": "Whitebox Static", "tech": "Complexity", "cls": "Cyclomatic", "status": "Execution completed", "result": "PASS"},
            {"tt": "Whitebox Static", "tech": "SAST", "cls": "Vulnerability", "status": "Tool failed", "result": "FAIL"}
        ]
    }

    excel_file = gen.generate_excel_tracker(run_data, filename="test_results.xlsx")
    assert excel_file.exists()
    assert excel_file.stat().st_size > 1000

    pdf_file = gen.generate_pdf_report(run_data, filename="test_review.pdf")
    assert pdf_file.exists()
    assert pdf_file.stat().st_size > 1000


def test_report_generator_on_real_v21_data(tmp_path):
    v21_path = Path("F:/ts_work/v21")
    if not v21_path.exists():
        pytest.skip("F:/ts_work/v21 not found")

    gen = ReportGenerator(output_dir=tmp_path)
    parsed = gen.parse_run_directory(v21_path)

    assert parsed["run_id"] == "54f00333-52e4-48e3-bc76-3a2b3c1ac7c6"
    assert parsed["total_tools"] == 131
    assert parsed["passed_tools"] > 0

    excel_file = gen.generate_excel_tracker(parsed)
    pdf_file = gen.generate_pdf_report(parsed)

    assert excel_file.exists()
    assert pdf_file.exists()


def _write_s3(dirpath, run_id, results):
    import json
    dirpath.mkdir(parents=True, exist_ok=True)
    (dirpath / "s3-check.json").write_text(json.dumps({
        "repo": "r", "branch": "b", "run_id": run_id, "commit_sha": "abc",
        "checks": [{"tool": f"t{i}", "result": r, "note": "n"} for i, r in enumerate(results)],
    }), encoding="utf-8")


def test_parse_s3_check_counts_each_verdict(tmp_path):
    _write_s3(tmp_path / "branchA", "run-1", ["PASS", "PASS", "EMPTY", "FAIL", "NA"])
    parsed = ReportGenerator(output_dir=tmp_path).parse_run_directory(tmp_path)
    assert parsed["run_id"] == "run-1"
    assert (parsed["passed_tools"], parsed["empty_tools"], parsed["failed_tools"], parsed["not_applicable"]) == (2, 1, 1, 1)
    assert parsed["total_tools"] == 5
    assert parsed["pass_rate"] == "50.0%"  # 2 of the 4 evaluable (N/A excluded)


def test_parse_s3_check_unknown_verdict_not_counted(tmp_path):
    _write_s3(tmp_path, "run-2", ["PASS", "WEIRD"])
    parsed = ReportGenerator(output_dir=tmp_path).parse_run_directory(tmp_path)
    assert parsed["total_tools"] == 1 and parsed["pass_rate"] == "100.0%"


def test_parse_empty_run_dir_is_not_a_pass(tmp_path):
    parsed = ReportGenerator(output_dir=tmp_path).parse_run_directory(tmp_path)
    assert parsed["total_tools"] == 0
    assert parsed["pass_rate"] == "N/A"


def test_excel_without_rows_has_no_fake_pass(tmp_path):
    import openpyxl
    gen = ReportGenerator(output_dir=tmp_path)
    f = gen.generate_excel_tracker({"rows": []}, filename="x.xlsx")
    ws = openpyxl.load_workbook(f)["Tool Execution Matrix"]
    assert [c.value for c in ws[2]][-1] == "N/A"
