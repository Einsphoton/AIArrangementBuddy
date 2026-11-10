/**
 * 训练功能发行清单（P8-C）。
 *
 * 训练所需的 代码/数据集/检查点/Python 全部钉死版本与哈希；只有用户点击「开始训练」才下载。
 * 检查点来自公开 HF 仓库 ACE-Step/Ace-Step1.5（MIT）；数据集/代码来自本仓库 Releases。
 */

export type TrainingPlatform = 'darwin-arm64' | 'win32-x64' | 'linux-x64'

export interface TrainingAsset {
  file: string
  url: string
  size: number
  sha256?: string
}

export interface TrainingCheckpointFile {
  path: string
  dest: string
  url: string
  size: number
  sha256?: string
}

export const TRAINING_CODE_RELEASE_TAG = 'training-code-v1'

export const TRAINING_DATA_RELEASE_TAG = 'training-data-v1'

export const TRAINING_CODE: TrainingAsset = {"file": "training-code-v1.tar.gz", "size": 330365, "sha256": "92912e91661e3d20f7acfdc198a92155861129bfce699f04d278130aa4738eb4", "url": "https://github.com/Einsphoton/AIArrangementBuddy/releases/download/training-code-v1/training-code-v1.tar.gz"}

export const TRAINING_DATASETS: Array<TrainingAsset & { id: string }> = [
  {"id": "jrpg_v1", "file": "dataset-jrpg_v1.tar.gz", "url": "https://github.com/Einsphoton/AIArrangementBuddy/releases/download/training-data-v1/dataset-jrpg_v1.tar.gz", "size": 77248630, "sha256": "61135a171d0b911ee21e06967fdd958638878ed323be0222b321f1303abc7cb0"},
  {"id": "jrpg_v2", "file": "dataset-jrpg_v2.tar.gz", "url": "https://github.com/Einsphoton/AIArrangementBuddy/releases/download/training-data-v1/dataset-jrpg_v2.tar.gz", "size": 217126315, "sha256": "ea9063afa60f896ab6f9f900e23b73c97ff4ff9bcf541234d6fdf37f85ff2ccd"},
  {"id": "jrock_v1", "file": "dataset-jrock_v1.tar.gz", "url": "https://github.com/Einsphoton/AIArrangementBuddy/releases/download/training-data-v1/dataset-jrock_v1.tar.gz", "size": 219057663, "sha256": "3d0b1df34a2ddaeb95b65ec1bb8de86424ac5cc3aa69ac5cd547c8930373df12"},
]

export const TRAINING_CHECKPOINTS: TrainingCheckpointFile[] = [
  {"path": "Qwen3-Embedding-0.6B/added_tokens.json", "dest": "Qwen3-Embedding-0.6B/added_tokens.json", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/Qwen3-Embedding-0.6B/added_tokens.json", "size": 707},
  {"path": "Qwen3-Embedding-0.6B/chat_template.jinja", "dest": "Qwen3-Embedding-0.6B/chat_template.jinja", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/Qwen3-Embedding-0.6B/chat_template.jinja", "size": 4116},
  {"path": "Qwen3-Embedding-0.6B/config.json", "dest": "Qwen3-Embedding-0.6B/config.json", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/Qwen3-Embedding-0.6B/config.json", "size": 1359},
  {"path": "Qwen3-Embedding-0.6B/merges.txt", "dest": "Qwen3-Embedding-0.6B/merges.txt", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/Qwen3-Embedding-0.6B/merges.txt", "size": 1671853},
  {"path": "Qwen3-Embedding-0.6B/model.safetensors", "dest": "Qwen3-Embedding-0.6B/model.safetensors", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/Qwen3-Embedding-0.6B/model.safetensors", "size": 1191586416, "sha256": "0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd"},
  {"path": "Qwen3-Embedding-0.6B/special_tokens_map.json", "dest": "Qwen3-Embedding-0.6B/special_tokens_map.json", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/Qwen3-Embedding-0.6B/special_tokens_map.json", "size": 613},
  {"path": "Qwen3-Embedding-0.6B/tokenizer.json", "dest": "Qwen3-Embedding-0.6B/tokenizer.json", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/Qwen3-Embedding-0.6B/tokenizer.json", "size": 11423705, "sha256": "def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a"},
  {"path": "Qwen3-Embedding-0.6B/tokenizer_config.json", "dest": "Qwen3-Embedding-0.6B/tokenizer_config.json", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/Qwen3-Embedding-0.6B/tokenizer_config.json", "size": 5404},
  {"path": "Qwen3-Embedding-0.6B/vocab.json", "dest": "Qwen3-Embedding-0.6B/vocab.json", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/Qwen3-Embedding-0.6B/vocab.json", "size": 2776833},
  {"path": "acestep-v15-turbo/config.json", "dest": "acestep-v15-turbo/config.json", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/acestep-v15-turbo/config.json", "size": 1968},
  {"path": "acestep-v15-turbo/configuration_acestep_v15.py", "dest": "acestep-v15-turbo/configuration_acestep_v15.py", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/acestep-v15-turbo/configuration_acestep_v15.py", "size": 13130},
  {"path": "acestep-v15-turbo/model.safetensors", "dest": "acestep-v15-turbo/model.safetensors", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/acestep-v15-turbo/model.safetensors", "size": 4787825604, "sha256": "3f6e0797fad420a39bd33979eb6e840e30989e34a3794e843d23b60ec6e422d7"},
  {"path": "acestep-v15-turbo/modeling_acestep_v15_turbo.py", "dest": "acestep-v15-turbo/modeling_acestep_v15_turbo.py", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/acestep-v15-turbo/modeling_acestep_v15_turbo.py", "size": 96036},
  {"path": "acestep-v15-turbo/silence_latent.pt", "dest": "acestep-v15-turbo/silence_latent.pt", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/acestep-v15-turbo/silence_latent.pt", "size": 3841215, "sha256": "a778e9dd942f5e8b2c09c55370782d318834432b03dabbcdf70e6ed49ad6358b"},
  {"path": "vae/config.json", "dest": "vae/config.json", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/vae/config.json", "size": 425},
  {"path": "vae/diffusion_pytorch_model.safetensors", "dest": "vae/diffusion_pytorch_model.safetensors", "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/vae/diffusion_pytorch_model.safetensors", "size": 337431388, "sha256": "da17edb604c40deaf09e9b24974e590d1ca83a374070e5d0884cfa4bed9a99b0"},
]

export const TRAINING_PYTHON: Record<TrainingPlatform, TrainingAsset> = {
  "darwin-arm64": {
    "file": "cpython-3.12.16+20261026-aarch64-apple-darwin-install_only.tar.gz",
    "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.12.16%2B20261026-aarch64-apple-darwin-install_only.tar.gz",
    "size": 25172086,
    "sha256": "fbf4afef53c2a6b72bb741bc06d5671a9dfaf87bd84e5aa73ac9b3d0d589f14e"
  },
  "linux-x64": {
    "file": "cpython-3.12.16+20261026-x86_64-unknown-linux-gnu-install_only.tar.gz",
    "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.12.16%2B20261026-x86_64-unknown-linux-gnu-install_only.tar.gz",
    "size": 67921566
  },
  "win32-x64": {
    "file": "cpython-3.12.16+20261026-x86_64-pc-windows-msvc-install_only.tar.gz",
    "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.12.16%2B20261026-x86_64-pc-windows-msvc-install_only.tar.gz",
    "size": 47113364
  }
}

export function trainingCheckpointBytes(): number {
  return TRAINING_CHECKPOINTS.reduce((sum, file) => sum + file.size, 0)
}

export function trainingDatasetBytes(): number {
  return TRAINING_DATASETS.reduce((sum, file) => sum + file.size, 0)
}
