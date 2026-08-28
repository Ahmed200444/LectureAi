from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

import psutil


@dataclass
class Hardware:
    cpu: str
    logical_cores: int
    ram_gb: float
    free_disk_gb: float
    nvidia_gpu: str | None
    gpu_vram_gb: float | None


def detect_hardware() -> Hardware:
    gpu_name: str | None = None
    gpu_vram: float | None = None
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            check=True,
            timeout=8,
        )
        first = result.stdout.strip().splitlines()[0]
        name, memory_mb = [part.strip() for part in first.rsplit(",", 1)]
        gpu_name = name
        gpu_vram = round(float(memory_mb) / 1024, 1)
    except (FileNotFoundError, subprocess.SubprocessError, IndexError, ValueError):
        pass

    disk_root = Path(__file__).resolve().anchor or os.getcwd()
    free_disk = shutil.disk_usage(disk_root).free / (1024 ** 3)
    return Hardware(
        cpu=platform.processor() or platform.machine(),
        logical_cores=psutil.cpu_count(logical=True) or 1,
        ram_gb=round(psutil.virtual_memory().total / (1024 ** 3), 1),
        free_disk_gb=round(free_disk, 1),
        nvidia_gpu=gpu_name,
        gpu_vram_gb=gpu_vram,
    )


def recommendation(hardware: Hardware) -> dict[str, str]:
    if hardware.nvidia_gpu and (hardware.gpu_vram_gb or 0) >= 10 and hardware.ram_gb >= 16:
        choice, reason = "large-v3", "NVIDIA GPU with enough VRAM for the strongest practical multilingual model."
    elif hardware.nvidia_gpu and (hardware.gpu_vram_gb or 0) >= 6 and hardware.ram_gb >= 12:
        choice, reason = "medium", "Balanced multilingual accuracy and GPU memory use."
    elif hardware.ram_gb >= 16:
        choice, reason = "medium", "Strong CPU-mode accuracy; processing will be slower than real time."
    else:
        choice, reason = "small", "Lower memory use while retaining multilingual support."
    return {"model": choice, "reason": reason}


if __name__ == "__main__":
    detected = detect_hardware()
    print(json.dumps({"hardware": asdict(detected), "recommendation": recommendation(detected)}, indent=2))
