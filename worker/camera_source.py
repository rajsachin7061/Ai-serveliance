import base64
import ipaddress
import json
import os
import sys
import time
from urllib.parse import quote, urlsplit, urlunsplit


def emit(payload):
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def valid_rtsp_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        return False
    try:
        parsed = urlsplit(value)
        address = ipaddress.ip_address(parsed.hostname) if parsed.hostname else None
        if not isinstance(address, ipaddress.IPv4Address):
            return False
        octets = [int(part) for part in str(address).split(".")]
        private_address = (
            octets[0] == 127
            or octets[0] == 10
            or (octets[0] == 172 and 16 <= octets[1] <= 31)
            or (octets[0] == 192 and octets[1] == 168)
            or (octets[0] == 169 and octets[1] == 254)
        )
        return (
            parsed.scheme == "rtsp"
            and private_address
            and parsed.username is None
            and parsed.password is None
            and not parsed.fragment
            and (parsed.port is None or 1 <= parsed.port <= 65535)
        )
    except ValueError:
        return False


def authenticated_rtsp_url(value, username, password):
    if not valid_rtsp_url(value):
        raise ValueError("Invalid RTSP endpoint.")
    if not isinstance(username, str) or not isinstance(password, str) \
            or len(username) > 128 or len(password) > 256 \
            or bool(username) != bool(password):
        raise ValueError("Invalid RTSP credentials.")
    if not username:
        return value
    parsed = urlsplit(value)
    netloc = f"{quote(username, safe='')}:{quote(password, safe='')}@{parsed.netloc}"
    return urlunsplit(parsed._replace(netloc=netloc))


def main():
    try:
        import cv2
    except ImportError:
        emit({"type": "error", "message": "OpenCV is missing. Install worker\\requirements.txt."})
        return 2

    line = sys.stdin.readline(4096)
    if not line:
        emit({"type": "error", "message": "No camera source was provided."})
        return 2
    try:
        packet = json.loads(line)
    except json.JSONDecodeError:
        emit({"type": "error", "message": "The camera source configuration is invalid."})
        return 2
    source_url = packet.get("url") if isinstance(packet, dict) else None
    if not valid_rtsp_url(source_url):
        emit({"type": "error", "message": "Use a valid RTSP URL without embedded credentials."})
        return 2
    username = packet.get("username", "")
    password = packet.get("password", "")
    try:
        source_url = authenticated_rtsp_url(source_url, username, password)
    except ValueError:
        emit({"type": "error", "message": "Invalid RTSP credentials."})
        return 2

    transport = packet.get("transport", "tcp")
    if transport not in ("tcp", "udp"):
        emit({"type": "error", "category": "invalid_configuration", "message": "RTSP transport must be TCP or UDP."})
        return 2
    try:
        processing_fps = float(packet.get("processingFps", 3))
        max_retries = int(packet.get("maxReconnectAttempts", 0))
        if not 1 <= processing_fps <= 30 or not 0 <= max_retries <= 30:
            raise ValueError
    except (TypeError, ValueError):
        emit({"type": "error", "category": "invalid_configuration", "message": "Camera stream settings are outside supported limits."})
        return 2

    emit({"type": "connecting"})
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = f"rtsp_transport;{transport}"
    retry_delay = 1
    retries = 0
    while True:
        capture = None
        try:
            capture = cv2.VideoCapture()
            opened = capture.open(source_url, cv2.CAP_FFMPEG, [
                cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000,
                cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000,
            ])
            if not opened or not capture.isOpened():
                retries += 1
                if max_retries and retries > max_retries:
                    emit({
                        "type": "error",
                        "category": "no_frames",
                        "message": "No video frame arrived after the configured connection attempts.",
                    })
                    return 1
                emit({"type": "reconnecting", "message": "The RTSP stream did not open; retrying."})
                time.sleep(retry_delay)
                retry_delay = min(30, retry_delay * 2)
                continue
            retry_delay = 1
            reported_connected = False
            received_frame = False
            last_frame = 0
            fps_started = time.monotonic()
            fps_frames = 0
            actual_fps = 0.0
            fourcc = int(capture.get(cv2.CAP_PROP_FOURCC) or 0)
            codec = "".join(chr((fourcc >> (8 * index)) & 0xFF) for index in range(4)).strip("\x00 ")
            if not codec or any(not character.isprintable() for character in codec):
                codec = "Unknown"
            while True:
                ok, frame = capture.read()
                if not ok or frame is None:
                    break
                received_frame = True
                now = time.monotonic()
                fps_frames += 1
                fps_elapsed = now - fps_started
                if fps_elapsed >= 1:
                    actual_fps = fps_frames / fps_elapsed
                    fps_started = now
                    fps_frames = 0
                if not reported_connected:
                    emit({"type": "connected"})
                    reported_connected = True
                if now - last_frame < 1 / processing_fps:
                    continue
                height, width = frame.shape[:2]
                brightness = sum(cv2.mean(frame)[:3]) / 3
                scale = min(1.0, 640 / max(width, height))
                if scale < 1:
                    frame = cv2.resize(frame, (max(1, int(width * scale)), max(1, int(height * scale))))
                encoded, image = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
                if not encoded:
                    emit({
                        "type": "reconnecting",
                        "category": "decoding_failed",
                        "message": "The decoded video frame could not be encoded for local processing.",
                    })
                    break
                emit({
                    "type": "frame",
                    "image": base64.b64encode(image).decode("ascii"),
                    "width": width,
                    "height": height,
                    "fps": round(actual_fps, 2),
                    "codec": codec,
                    "brightness": round(brightness, 2),
                })
                last_frame = now
                retries = 0
            emit({
                "type": "reconnecting",
                "category": "network_interruption" if received_frame else "no_frames",
                "message": "The RTSP stream was interrupted; retrying."
                if received_frame else "The RTSP connection did not deliver a video frame; retrying.",
            })
        except Exception:
            emit({"type": "reconnecting", "message": "The RTSP stream is unavailable; retrying."})
        finally:
            if capture is not None:
                capture.release()
        retries += 1
        if max_retries and retries > max_retries:
            emit({
                "type": "error",
                "category": "no_frames",
                "message": "The RTSP stream stopped delivering frames after the configured retry limit.",
            })
            return 1
        time.sleep(retry_delay)
        retry_delay = min(30, retry_delay * 2)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
