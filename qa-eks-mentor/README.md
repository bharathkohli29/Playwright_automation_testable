# QA EKS Mentor: "tool not triggered" analysis reports

When the Playwright run finds a Whitebox tool that never triggered, this tool pulls that tool's evidence from the
**QA EKS** cluster and writes one PDF per tool: `Analysis_Report_<tool>_<run>.pdf` (plus a Markdown copy).

## How it works

| Step | Done by |
|---|---|
| Read logs from the 9 `whitebox-cell-001` services (current + previous container), pod health | `analyze.py` (kubectl, read-only) |
| Find the planning decision (`planning.compatibility_excluded`), errors, gaps | `analyze.py` rules |
| Verdict, root cause, owner, fix, acceptance criteria | `analyze.py` rules (reason table `REASONS`) |
| 2-3 sentence executive summary | the local Ollama model; falls back to the rules text if its output looks wrong |
| Build the PDF | `analyze.py` (reportlab) |

The model is only used for the summary. It never decides the cause, and with no log lines the report says
**Insufficient evidence** instead of guessing.

## Setup (once per machine)

1. **Python 3.10+**, then `pip install -r requirements.txt`
2. **AWS CLI v2 + kubectl**, with the read-only QA profile `qa-eks-ro` and kube context `qa-eks-ro`
   (ask the QA EKS maintainer for the access guide; never put credentials in this repo).
3. **Ollama** from https://ollama.com, then create the model:
   ```bash
   # put the .gguf next to the Modelfile first (not in git, ~1.9 GB; ask the owner or build it with MODEL_TRAINING_GUIDE.md)
   ollama create qa-eks-mentor-trained -f Modelfile
   ```
   Without the model, run with `--no-llm`: the reports are identical except the summary is rule-based.

## Usage

```bash
aws sso login --profile qa-eks-ro --no-browser     # sign in (private window), refresh when it expires
python analyze.py --run-id <run-id> --tool crosshair,pymcdc --facts facts.md
python analyze.py --run-id <run-id> --tool crosshair --no-llm
```

Output goes to `reports/` (git-ignored). `--facts` is an optional text file with what the Playwright/defect report
already knows (repo, branch, commit, observed symptoms); see `examples/`. Example output: `examples/SAMPLE_Analysis_Report_crosshair_86a8ebb0.pdf`.

If the cluster is unreachable the script stops with an error instead of producing an empty report.

## Limits to know

- **Run it right after the Playwright run.** `kubectl logs` only keeps the current and previous container; a pod restart
  drops older logs, so old runs come out as *Insufficient evidence* unless logs are archived elsewhere.
- The QA EKS cluster must be reachable from your network (VPN / IP allowlist may be required).
- The fine-tuning set in `training/dataset.jsonl` is tiny (2 examples). Treat the model as a summariser, not an analyst,
  until it is trained on ~50-100 real examples (see `MODEL_TRAINING_GUIDE.md`).
- New "not triggered" reasons need a row in `REASONS` in `analyze.py` (meaning, owner, action) to get a specific fix.

## Files

```
analyze.py                  log collection, rules, summary call, PDF/Markdown output
MENTOR_PROMPT.md, Modelfile persona rules and the Ollama model definition
training/                   dataset builder, Colab training script/notebook, dataset.jsonl
examples/                   sample facts files and a sample PDF
MODEL_TRAINING_GUIDE.md     how to fine-tune and import the model
QA_EKS_MENTOR_DOCUMENTATION.md   architecture and methodology
```
