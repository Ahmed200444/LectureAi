from __future__ import annotations

import argparse
from pathlib import Path

import qrcode
from qrcode.constants import ERROR_CORRECT_M


def write_qr(value: str, output: Path) -> None:
    """Write a local QR image without printing its value to stdout or logs."""
    if not value or len(value) > 4096:
        raise ValueError("QR input must contain between 1 and 4096 characters.")
    output.parent.mkdir(parents=True, exist_ok=True)
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_M, box_size=16, border=4)
    qr.add_data(value)
    qr.make(fit=True)
    qr.make_image(fill_color="black", back_color="white").save(output)


def main() -> None:
    parser = argparse.ArgumentParser(description="Write a LectureAI runtime QR without logging its contents")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--label", default="LectureAI")
    args = parser.parse_args()
    value = args.input.read_text(encoding="utf-8").strip()
    write_qr(value, args.output)
    print(f"{args.label} QR image written.")


if __name__ == "__main__":
    main()
