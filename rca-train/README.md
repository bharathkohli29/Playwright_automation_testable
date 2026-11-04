# Local training of the RCA writer

Everything here runs on this PC (no cloud). A 4-bit base model plus a small LoRA adapter is trained on the RTX 3050 (4 GB). The environment, every cache and the model files live on F: because C: was full on 4 Nov 2026.

## Environment (set up on 4 Nov 2026)

`powershell -ExecutionPolicy Bypass -File rca-train\setup-windows.ps1` creates `F:\rca-train\.venv` (Python 3.13, PyTorch 2.14 with CUDA 12.6, transformers, peft, bitsandbytes) with TEMP, pip cache and Hugging Face cache on F:. The base model is `Qwen/Qwen2.5-1.5B-Instruct` (3.1 GB, Apache-2.0) in `F:\rca-train\base\Qwen2.5-1.5B-Instruct`. The 3B base is under the Qwen Research License and does not fit the free GPU memory: not used.

## What the measurement showed (26 examples, 2 epochs, unreviewed drafts, 4 Nov 2026)

- It trains: 18.5 million trainable parameters (1.2%), loss 1.05 down to 0.79 in 6 optimizer steps.
- Speed: about 320 tokens per second, 140 seconds for 44,000 tokens. A real run of 150 reviewed cases (about 850 tokens each, 2 to 3 epochs) is therefore roughly 13 to 20 minutes; 300 cases about 30 to 40 minutes.
- GPU memory: peak 4.56 GB allocated on a 4 GB card. Windows lets CUDA spill into shared system memory, so it works but slower and with a warning ("memory allocation failed with OOM ... free: 0"). To stay inside 4 GB: `--max-len 1024` (drops the longest examples) or `--rank 8`.
- The adapter of this run is in `F:\rca-train\out-measure-DO-NOT-USE`: it learned its own unreviewed drafts and must never be used.

## Measure again (no usable model comes out of this)

```
set TEMP=F:\rca-train\tmp & set HF_HOME=F:\rca-train\hf
F:\rca-train\.venv\Scripts\python.exe rca-train\train_lora.py --from-facts --data results\rca-dataset\sample\facts.jsonl --base F:\rca-train\base\Qwen2.5-1.5B-Instruct --out F:\rca-train\out-measure --max-steps 20
```

## Real training (only with reviewed cases)

1. `npm run rca:dataset -- export "<branch folder>" ...`, two reviewers fill `review.xlsx`, then `npm run rca:dataset -- import "<dir>\review.xlsx"`.
2. Aim for 150 or more approved cases (`dataset.json` says `enough`).
3. Train on `train.jsonl` (same command without `--from-facts`), then score on `holdout.jsonl`. The adapter is only used if it beats the stock model on the held-out cases and the checks in `utils/rcaWriter.ts` still accept its answers.
4. Load it into the local Ollama as a NEW model name (merge into the base and convert to GGUF with llama.cpp, or an `ADAPTER` line in a Modelfile); `RCA_MODEL_NAME` in `.env` picks it. The stock `rca-writer` stays as the fallback. The llama.cpp converter is not downloaded yet.
