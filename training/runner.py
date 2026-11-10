#!/usr/bin/env python3
"""ArrangementBuddy 训练 runner（P8-C，跨平台）。

由产品服务端调用（Node -> 训练 venv 的 python training/runner.py）。

环境变量：
  AIAB_TRAINING_CODE     训练代码目录（内含 acestep/ 包与 pyshim；安装器解压到这里）
  AIAB_TRAINING_CKPT     检查点根目录（子目录 acestep-v15-turbo / vae / Qwen3-Embedding-0.6B）
  AIAB_TRAINING_WORK     工作目录（张量/输出/日志）
  AIAB_TRAINING_CACHE    模型缓存（HF/torch/mpl）

参数：
  --stage preprocess|lora|all
  --dataset <目录>（含 wav + json + lyrics）
  --tag <实验名>
  --epochs N  --rank N  --max-duration SEC
  --device auto|cuda|mps|cpu      --precision auto|bf16|fp16|fp32

输出（供服务端解析/注册适配器）：
  最终一行：TRAINING_DONE output=<绝对路径> files=<n> bytes=<n>
  失败：TRAINING_FAILED reason=...
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

TRAIN_MODULE = "acestep.training_v2.cli.train_fixed"


def env_paths() -> dict[str, Path]:
    root = Path(__file__).resolve().parent
    code = Path(os.environ.get("AIAB_TRAINING_CODE") or root).resolve()
    ckpt = Path(os.environ.get("AIAB_TRAINING_CKPT") or (root / "checkpoints")).resolve()
    work = Path(os.environ.get("AIAB_TRAINING_WORK") or (root / "work")).resolve()
    cache = Path(os.environ.get("AIAB_TRAINING_CACHE") or (work / "cache")).resolve()
    common = Path(os.path.commonpath([str(code), str(ckpt), str(work)]))
    return {"root": root, "code": code, "ckpt": ckpt, "work": work, "cache": cache, "common": common}


def build_env(paths: dict[str, Path]) -> dict[str, str]:
    env = dict(os.environ)
    for name, sub in {
        "MPLCONFIGDIR": "mpl",
        "HF_HOME": "hf",
        "TORCH_HOME": "torch",
        "TRITON_CACHE_DIR": "triton",
        "UV_CACHE_DIR": "uv",
    }.items():
        target = paths["cache"] / sub
        target.mkdir(parents=True, exist_ok=True)
        env[name] = str(target)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    shim_env = os.environ.get("AIAB_TRAINING_SHIM")
    code = paths["code"]
    shim_candidates = []
    if shim_env:
        shim_candidates.append(Path(shim_env).resolve())
    shim_candidates += [code / "pyshim", paths["root"] / "pyshim"]
    shim = next((candidate for candidate in shim_candidates if candidate.exists()), None)
    parts = []
    if shim is not None:
        parts.append(str(shim))
    if (code / "acestep").exists():
        parts.append(str(code))
    else:
        parts.append(str(paths["root"]))
    env["PYTHONPATH"] = os.pathsep.join(parts)
    # Windows 无 Triton：LyCORIS 走 eager torch 后端
    env.setdefault("LYCORIS_KERNEL_BACKEND", "torch")
    return env


def run(argv: list[str], log_path: Path, cwd: Path, env: dict[str, str]) -> int:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"$ {' '.join(argv)}", flush=True)
    print(f"  log → {log_path}", flush=True)
    started = time.time()
    with open(log_path, "w", encoding="utf-8", errors="replace") as log:
        proc = subprocess.Popen(
            argv,
            cwd=str(cwd),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            log.write(line)
            log.flush()
        proc.wait()
    print(f"退出码 {proc.returncode}，耗时 {time.time() - started:.1f}s", flush=True)
    return proc.returncode if proc.returncode is not None else 1


def ensure_dirs(paths: dict[str, Path], tag: str) -> dict[str, Path]:
    paths["work"].mkdir(parents=True, exist_ok=True)
    (paths["work"] / "logs").mkdir(parents=True, exist_ok=True)
    tensors = paths["work"] / f"tensors_{tag}"
    return {"tensors": tensors, "logs": paths["work"] / "logs"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, choices=["preprocess", "lora", "all"])
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--epochs", type=int, default=0)
    ap.add_argument("--rank", type=int, default=32)
    ap.add_argument("--max-duration", type=float, default=240.0)
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cuda:0", "mps", "cpu"])
    ap.add_argument("--precision", default="auto", choices=["auto", "bf16", "fp16", "fp32"])
    ap.add_argument("--base-model", default="turbo")
    args = ap.parse_args()

    paths = env_paths()
    env = build_env(paths)
    dataset = Path(args.dataset).resolve()
    if not dataset.exists():
        print(f"TRAINING_FAILED reason=数据集不存在：{dataset}", flush=True)
        return 1
    if not (paths["ckpt"] / "acestep-v15-turbo").exists():
        print(f"TRAINING_FAILED reason=缺少检查点：{paths['ckpt'] / 'acestep-v15-turbo'}", flush=True)
        return 1
    dirs = ensure_dirs(paths, args.tag)

    def preprocess() -> int:
        if (dirs["tensors"] / "manifest.json").exists():
            print(f"[skip] 张量已存在：{dirs['tensors']}", flush=True)
            return 0
        if dirs["tensors"].exists():
            shutil.rmtree(dirs["tensors"], ignore_errors=True)
        code = run(
            [
                sys.executable, "-m", TRAIN_MODULE,
                "--preprocess",
                "--audio-dir", str(dataset),
                "--tensor-output", str(dirs["tensors"]),
                "--checkpoint-dir", str(paths["ckpt"]),
                "--base-model", args.base_model,
                "--device", args.device,
                "--precision", args.precision,
                "--max-duration", str(args.max_duration),
                "--plain",
            ],
            dirs["logs"] / f"preprocess_{args.tag}.log",
            paths["common"],
            env,
        )
        pts = list(dirs["tensors"].glob("**/*.pt")) if dirs["tensors"].exists() else []
        if code != 0 or not pts:
            print(f"TRAINING_FAILED reason=预处理失败或没有张量（code={code}, pts={len(pts)}）", flush=True)
            return 1
        print(f"[ok] 预处理 {len(pts)} 个张量", flush=True)
        return 0

    def train() -> int:
        out = paths["work"] / "out" / f"{args.tag}_lora"
        shutil.rmtree(out, ignore_errors=True)
        epochs = args.epochs if args.epochs > 0 else 120
        code = run(
            [
                sys.executable, "-m", TRAIN_MODULE,
                "--dataset-dir", str(dirs["tensors"]),
                "--checkpoint-dir", str(paths["ckpt"]),
                "--base-model", args.base_model,
                "--output-dir", str(out),
                "--adapter-type", "lora",
                "--rank", str(args.rank),
                "--epochs", str(epochs),
                "--lr", "1e-4",
                "--batch-size", "1",
                "--gradient-accumulation", "1",
                "--shift", "3.0",
                "--num-inference-steps", "8",
                "--save-every", str(max(10, epochs // 5)),
                "--device", args.device,
                "--precision", args.precision,
                "--plain",
                "--yes",
            ],
            dirs["logs"] / f"lora_{args.tag}.log",
            paths["common"],
            env,
        )
        final = out / "final" / "adapter_model.safetensors"
        files = [f for f in out.rglob("*") if f.is_file() and f.suffix in (".safetensors", ".pt", ".bin")] if out.exists() else []
        if code != 0 or not final.exists():
            print(f"TRAINING_FAILED reason=训练失败或没有 final 权重（code={code}, files={len(files)}, final={final.exists()}）", flush=True)
            return 1
        total = sum(f.stat().st_size for f in files)
        print(f"TRAINING_DONE output={out.resolve()} files={len(files)} bytes={total}", flush=True)
        return 0

    if args.stage in ("preprocess", "all"):
        code = preprocess()
        if code != 0:
            return code
    if args.stage in ("lora", "all"):
        return train()
    return 0


if __name__ == "__main__":
    sys.exit(main())
