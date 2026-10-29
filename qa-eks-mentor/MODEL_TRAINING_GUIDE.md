# Whitebox QA EKS Mentor - End-to-End Model Training Guide

This guide is a complete, beginner-friendly walkthrough for fine-tuning a custom Large Language Model (LLM) to act as a **Whitebox QA EKS Analyst** and deploying it into your local Ollama environment.

---

## 1. Architecture Overview

```mermaid
flowchart LR
    subgraph DataPrep [1. Data Preparation]
        A["Past EKS Logs & Defect Reports"] --> B["prepare_dataset.py"]
        B --> C["dataset.jsonl<br>(ChatML format)"]
    end

    subgraph CloudTrain [2. Cloud Training (Free Google Colab)]
        C --> D["Unsloth + QLoRA<br>(Qwen 2.5/3 Base Model)"]
        D --> E["qa-eks-mentor.gguf<br>(Quantized Weights)"]
    end

    subgraph LocalDeploy [3. Local Ollama & Automation]
        E --> F["Modelfile"]
        F --> G["ollama create qa-eks-mentor-v2"]
        G --> H["Python Automation Scripts<br>(analyze.py / Jira Updaters)"]
    end
```

### Key Concept Cheat Sheet

| Term | What It Is in Plain English |
| :--- | :--- |
| **Weights** | The billions of mathematical values ("slider knobs") inside the model that determine its reasoning. |
| **LoRA** | Attaching small, trainable "sticky-note" matrices (~1% new parameters) to a frozen base model instead of retraining all 4 billion weights. |
| **QLoRA** | Compressing the base model into 4-bit memory so it fits on free cloud GPUs (like Google Colab's 16 GB T4). |
| **GGUF** | The binary file format that Ollama reads and executes locally on your CPU/GPU. |
| **Modelfile** | The configuration file that tells Ollama which GGUF to load, what temperature to use, and what system prompt to inject. |

---

## 2. Directory Structure

All training assets are organized in `qa-eks-mentor\`:

```
qa-eks-mentor\
├── MODEL_TRAINING_GUIDE.md      # This guide
├── Modelfile                     # Ollama configuration
├── MENTOR_PROMPT.md              # System prompt and persona rules
├── analyze.py                    # Live kubectl log extractor & runner
└── training\
    ├── prepare_dataset.py        # Generates dataset.jsonl from QA examples
    ├── dataset.jsonl             # Output training dataset (JSON Lines)
    └── train_colab.py            # Ready-to-run Google Colab training script
```

---

## 3. Step-by-Step Training Walkthrough

---

### Step 1: Prepare the Training Dataset

LLMs learn by example using the **ChatML** format (`system`, `user`, `assistant`).

1. Open [`prepare_dataset.py`](training/prepare_dataset.py).
2. Look at the `EXAMPLES` array. Each entry has:
   * **`evidence`**: The raw input (tool name, run ID, kubectl logs, pod states).
   * **`expected_output`**: The gold-standard defect analysis report you want the model to generate.
3. Add your own real examples of past runs (aim for 20 to 100+ examples for a robust model).
4. Run the script in PowerShell:
   ```powershell
   python qa-eks-mentor\training\prepare_dataset.py
   ```
5. This generates [`dataset.jsonl`](training/dataset.jsonl). Each line is formatted like:
   ```json
   {
     "messages": [
       {"role": "system", "content": "You are a Whitebox QA defect analysis analyst..."},
       {"role": "user", "content": "EVIDENCE:\nTOOL: crosshair\nRUN ID: bbbd08e3..."},
       {"role": "assistant", "content": "# crosshair - Not Triggered (Run bbbd08e3)..."}
     ]
   }
   ```

---

### Step 2: Train in Google Colab (Free T4 GPU)

Because local training of a 4B model requires 8+ GB VRAM and your local laptop GPU has 4 GB VRAM, we train for free on Google Colab's **16 GB Nvidia T4 GPU**.

1. Go to [Google Colab](https://colab.research.google.com/) and create a **New Notebook**.
2. **Enable GPU**:
   * Navigate to: **Runtime** $\rightarrow$ **Change runtime type**.
   * Under *Hardware accelerator*, select **T4 GPU** and click **Save**.
3. **Upload Files**:
   * On the left sidebar, click the **Folder icon** 📁.
   * Upload `dataset.jsonl` and `train_colab.py` from `qa-eks-mentor\training\`.
4. **Install Unsloth & Dependencies** (in a Colab code cell):
   ```bash
   !pip install "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git"
   !pip install --no-deps trl peft accelerate bitsandbytes
   ```
5. **Execute Training**:
   Run the code from [`train_colab.py`](training/train_colab.py).

#### What Happens During Training?
* **Base Model Loading:** Downloads `Qwen/Qwen2.5-3B-Instruct` in 4-bit precision (~2 GB).
* **LoRA Initialization:** Freezes base weights and attaches adapters to attention matrices (`q_proj`, `v_proj`, etc.).
* **Optimization:** Runs gradient descent for 60–100 steps. You will see a `loss` metric decreasing from ~2.5 down to ~0.4 (lower loss = model is learning your report structure).
* **GGUF Export:** Converts the fine-tuned model into `qa-eks-mentor-trained-q4_k_m.gguf`.

---

### Step 3: Deploy the Trained Model into Local Ollama

Once Colab finishes:

1. **Download the GGUF file**:
   From the Colab files pane, download `qa-eks-mentor-trained-q4_k_m.gguf` to:
   ```
   qa-eks-mentor\qa-eks-mentor-trained-q4_k_m.gguf
   ```
2. **Update the [Modelfile](Modelfile)**:
   ```dockerfile
   FROM ./qa-eks-mentor-trained-q4_k_m.gguf

   PARAMETER temperature 0.1
   PARAMETER num_ctx 4096

   SYSTEM """You are a Whitebox QA analyst. You write defect analysis reports using ONLY the EVIDENCE block provided."""
   ```
3. **Build the Model in Ollama** (in PowerShell):
   ```powershell
   cd qa-eks-mentor
   ..\ollama.exe create qa-eks-mentor-v2 -f .\Modelfile
   ```
4. **Test the Model**:
   ```powershell
   ..\ollama.exe run qa-eks-mentor-v2 "TOOL: crosshair, RUN: test-123. Give me a QA report."
   ```

---

## 4. Connecting the Model to Your Automation Scripts

You can call your trained model directly from Python automation scripts via Ollama's local REST API:

```python
import urllib.request
import json

def analyze_defect_with_ai(tool: str, run_id: str, eks_logs: str) -> dict:
    """Sends fresh EKS logs and metadata to the local fine-tuned Ollama model."""
    prompt = f"TOOL: {tool}\nRUN ID: {run_id}\nEVIDENCE:\n{eks_logs}"
    
    payload = {
        "model": "qa-eks-mentor-v2",
        "stream": False,
        "options": {
            "temperature": 0.1,
            "num_ctx": 4096
        },
        "messages": [
            {"role": "user", "content": prompt}
        ]
    }
    
    req = urllib.request.Request(
        "http://localhost:11434/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    
    with urllib.request.urlopen(req, timeout=120) as response:
        res = json.loads(response.read().decode("utf-8"))
        return res["message"]["content"]

# Example usage in your existing automation:
if __name__ == "__main__":
    logs = "cell-001-wb-orchestrator: planning.compatibility_excluded crosshair 0.0.60 reason: CUSTOMER_CODE_INCOMPATIBLE"
    report = analyze_defect_with_ai("crosshair", "79784ed2-ca47-4ad6-a81d-e01f575408f8", logs)
    print("AI Defect Report:\n", report)
```

---

## 5. Best Practices & Troubleshooting

### Rule 1: Always Enforce Ground-Truth Citations
* The model must cite log timestamps and logger names from the input evidence.
* If a run has no logs, the trained model should cleanly declare **Verdict: Insufficient evidence** rather than hallucinating an error.

### Rule 2: Keep Temperature Low (`0.1`)
* For creative writing, temperature is 0.7–1.0.
* For QA defect analysis, keep temperature at **`0.1`**. This forces the model to be deterministic, factual, and strictly aligned with the training data.

### Rule 3: Troubleshooting Google Colab
* **CUDA Out of Memory:** Reduce `per_device_train_batch_size` from `2` to `1` in `train_colab.py`.
* **Session Disconnects:** Colab free tier has an idle timeout. Keep the browser tab open while `trainer.train()` runs.

