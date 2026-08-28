from __future__ import annotations

from pathlib import Path

from engine import MODEL_INFO, hardware_payload, load_model


def main() -> None:
    payload = hardware_payload()
    hardware = payload["hardware"]
    recommended = payload["recommendation"]
    print("\nDetected hardware")
    print(f"  CPU: {hardware['cpu']} ({hardware['logical_cores']} logical cores)")
    print(f"  RAM: {hardware['ram_gb']} GB")
    print(f"  NVIDIA GPU: {hardware['nvidia_gpu'] or 'Not detected'}")
    if hardware["gpu_vram_gb"]:
        print(f"  GPU VRAM: {hardware['gpu_vram_gb']} GB")
    print(f"  Free disk: {hardware['free_disk_gb']} GB")
    print(f"\nRecommended: {recommended['model']} — {recommended['reason']}")
    for name, info in MODEL_INFO.items():
        print(f"  {info['label']}: {name}; download {info['download']}; storage {info['storage']}; {info['memory']}")
    choice = input(f"\nModel to download [{recommended['model']}]: ").strip() or recommended["model"]
    if choice not in MODEL_INFO:
        raise SystemExit("Unknown model. Choose small, medium, or large-v3.")
    info = MODEL_INFO[choice]
    confirm = input(f"Download {choice} ({info['download']}, requires {info['storage']} storage)? [y/N]: ").strip().lower()
    if confirm != "y":
        print("No model downloaded. You can rerun setup_model.py later.")
        return
    models_dir = Path(__file__).resolve().parent.parent / "models"
    models_dir.mkdir(exist_ok=True)
    load_model(choice, models_dir)
    (models_dir / "selected-model.txt").write_text(choice, encoding="utf-8")
    print(f"\n{choice} is ready. No paid API or recurring transcription charge is used.")


if __name__ == "__main__":
    main()
