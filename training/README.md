# 训练代码包说明（P8-C）

本目录的 `runner.py` 是产品服务端调用的跨平台训练入口；训练算法本体来自：
- **ACE-Step**（https://github.com/ace-step/ACE-Step，MIT License）
- **Side-Step / ACE-Step Training V2**（https://github.com/koda-dernet/Side-Step，MIT License）

本仓库分发的是 **训练代码快照**（`acestep/training`、`acestep/training_v2`、`acestep/models` 的最小可用子集）
与 `acestep.training_v2` 所需的 `pyshim`（torchaudio → soundfile 兼容层），仅用于本地 LoRA 微调。

## 权利边界
- 训练代码按其上游 MIT 许可证分发；模型权重来自 HF 公开仓库（MIT/见模型卡）。
- **训练数据集**只包含 ACE-Step 自生成数据（`training-data-v1` 发布），不含任何第三方录音。
- 用户用自有/授权数据训练出的适配器，其权利与分发责任归用户；产品不会自动上传任何训练产物。

## 使用方式
产品「开始训练」会自动下载本代码包 + 数据集 + 基座检查点 + 独立 Python 环境；也可手动：

```bash
# 前置：把本目录（含 runner.py、acestep/、pyshim/）放到 AIAB_TRAINING_CODE
export AIAB_TRAINING_CODE=/path/to/training-code
export AIAB_TRAINING_CKPT=/path/to/checkpoints
export AIAB_TRAINING_WORK=/path/to/work
python training/runner.py --stage all --dataset /path/to/dataset --tag my_style --epochs 120 --device mps --precision fp32
```

macOS 使用 `--device mps --precision fp32`（比 CUDA 慢，建议 epochs 60–100 起步）；Windows/Linux CUDA 用 `--device cuda --precision bf16`。