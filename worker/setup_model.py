import argparse
import shutil
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Download the YOLOv8n model once for QueuePulse AI.")
    parser.add_argument("--output", required=True, type=Path, help="Destination path for yolov8n.pt")
    args = parser.parse_args()

    try:
        from ultralytics import YOLO
    except ImportError as error:
        print(f"Missing Python dependency: {error.name}. Install worker\\requirements.txt first.", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    print("Downloading/loading the official Ultralytics YOLOv8n pretrained weights…")
    try:
        model = YOLO("yolov8n.pt", task="detect")
        source = Path(model.ckpt_path)
        if not source.is_file():
            raise FileNotFoundError(f"Ultralytics did not provide the downloaded model file: {source}")
        if source.resolve() != args.output.resolve():
            shutil.copy2(source, args.output)
    except Exception as error:
        print(f"Model setup failed: {error}", file=sys.stderr)
        return 1

    if not args.output.is_file() or args.output.stat().st_size < 1_000_000:
        print(f"Downloaded model is missing or incomplete: {args.output}", file=sys.stderr)
        return 1

    print(f"YOLOv8n ready at: {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
