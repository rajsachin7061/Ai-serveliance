# QueuePulse AI — Windows desktop app

QueuePulse AI is a local React, Vite, Electron, and Python application for person tracking and basic retail traffic analytics. Camera streams have independent lifecycles; Live Monitor selects only which camera is previewed. Frames are sent over a validated Electron IPC bridge and processed locally with YOLOv8n and Ultralytics ByteTrack.

## Requirements

- Windows 10/11, Node.js 20.19+ and npm
- Python 3.10–3.12 (64-bit) and the Python launcher (`py`)
- A Windows webcam. For DroidCam, start its Windows client and confirm Windows lists **DroidCam Video**
- Internet access for the one-time Python dependency and model setup

## First-time AI setup

Run these commands from the project directory in PowerShell. These commands install CPU PyTorch; a GPU is not required.

```powershell
py -3 --version
py -3 -m pip install --upgrade pip
py -3 -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
py -3 -m pip install -r worker\requirements.txt
py -3 worker\setup_model.py --output "$env:APPDATA\queuepulse-ai\models\yolov8n.pt"
```

The setup script downloads the pretrained `yolov8n.pt` model once. The app expects it at `%APPDATA%\queuepulse-ai\models\yolov8n.pt` and does not download weights when it starts. If `py -3` selects a different interpreter than the one with dependencies installed, set `QUEUEPULSE_PYTHON` to that interpreter's executable before launching the app.

After installing the NSIS app, install the same dependencies and use its packaged setup script:

```powershell
$worker = "$env:LOCALAPPDATA\Programs\QueuePulse AI\resources\worker"
py -3 -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
py -3 -m pip install -r "$worker\requirements.txt"
py -3 "$worker\setup_model.py" --output "$env:APPDATA\queuepulse-ai\models\yolov8n.pt"
```

If you chose a different install location, set `$worker` to that install's `resources\worker` folder.

## Run and build

```powershell
npm install
npm run dev
npm run build
npm run dist:win
```

The installer is written to `release\`. It includes Electron, the React dashboard, and Python worker source, but not Python, Python packages, or model weights. Each Windows account/device must have Python and the worker dependencies installed and complete the one-time model setup above. Windows camera privacy settings must allow desktop apps to use the webcam.

The installer is unsigned and uses Electron's default app icon. Configure code signing and a QueuePulse icon before public distribution.

## Camera discovery and monitor setup

1. Open **Camera discovery**. Windows video inputs (USB webcams, DroidCam, built-in cameras, and HDMI capture cards exposed as video inputs) are listed locally.
2. Select **Start discovery** to send a bounded ONVIF WS-Discovery probe on the local network. It stops automatically after 3.5 seconds; use **Stop discovery** to end it sooner. Discovery itself does not scan arbitrary IPs or guess passwords. RTSP port checks run only when you explicitly test a saved profile.
3. For an ONVIF camera or recorder, choose **Get streams / channels** and enter an authorized ONVIF account. QueuePulse reads device information, media profiles, and RTSP stream URIs. Select **Add channel** for each stream you want to configure.
4. For a non-ONVIF camera, enter its vendor-provided RTSP URL in **Manual RTSP configuration**. Use a private IPv4 address and keep credentials in the separate fields; do not put credentials in the URL.
5. Add or connect a Windows camera from discovery, or open **Live monitor** and select a saved camera profile. If Windows hides device labels, allow camera access for desktop apps and refresh devices.
6. Draw/configure the queue rectangle; adjust the confidence threshold and count line, then save. Add restricted-area rectangles, loitering zones, and crowd zones as needed.
7. Review persisted alerts in **Alerts & events**. Events and analytics are processed and stored locally.

Camera profiles retain their own source, location, and monitor configuration, and display their live connection status. Connect profiles independently; switching the preview or leaving Live Monitor does not disconnect a stream. Disconnect or remove a profile explicitly to stop only that camera. Editing an RTSP URL, transport, or processing FPS restarts only that profile. **Settings** controls the maximum simultaneous connections (1–16, default 4), reconnect attempt limit (0 means unlimited exponential backoff), and automatic RTSP reconnect on application startup. At the connection limit, QueuePulse refuses a new connection rather than stopping an existing one. USB streams remain active while the app is running, but require manual reconnection after an app restart.

Open **Camera diagnostics** for on-demand TCP reachability and RTSP port measurements, actual decoded frame receipt, resolution, measured FPS, codec, last-frame time, credential-verification status, current AI worker status, and system resource information. **Test connection** reuses a healthy RTSP stream or starts only that camera; **Retry connection** and **Reconnect camera** affect only the selected camera. USB tests temporarily open the selected Windows device and stop only the temporary test stream; USB retry/reconnect reacquires only that device. Active USB streams report measured frame health independently of the selected preview. Exported JSON omits credentials and RTSP URLs. No frame or successful RTSP request is reported as healthy after the last-frame timeout. A very dark image is flagged as a suspected black screen, not proof of camera failure. ONVIF discovery remains a separate explicit action.

RTSP transport (TCP or UDP) and processing FPS (1–30) are configurable per profile. Use the vendor’s RTSP URL to select a main or sub-stream; ONVIF can expose named profiles/channels when the camera or recorder supports it. QueuePulse deliberately does not guess vendor-specific paths. Windows Firewall should allow QueuePulse’s required outbound RTSP traffic on the appropriate private network; do not disable the firewall. UDP media may require a network/firewall rule appropriate to the camera’s RTP ports. Analytics can be filtered to the last 5, 10, or 30 minutes or hour using saved event timestamps. **Print report** opens a report preview with the selected period's camera information, traffic totals, occupancy, and events; use **Print** for the system print dialog or **Save as PDF** to export a PDF.

Credentials that users choose to remember are encrypted with Electron `safeStorage` (Windows account protection) in the app's local user-data folder. Passwords are not written to application logs or exported diagnostic reports. RTSP URLs without embedded credentials are stored in local settings. Uncheck the remember option to provide credentials for a single connection.

Live Monitor previews one selected profile, while connected cameras continue capturing independently. The single centralized AI worker currently analyzes only the selected preview stream; selecting another camera changes its input without creating another AI worker.

Person boxes include ByteTrack IDs and confidence. The crowd state is normal below 80%, warning at 80%, and critical at the configured capacity. Zone intrusion alerts are generated on entry; loitering alerts wait for the configured duration; crowd alerts are edge-triggered and do not repeat until the threshold clears and is crossed again.

## Local data and security

App preferences and non-secret camera configuration are stored in Electron's app data `settings.json`; remembered camera credentials are stored separately as `camera-secrets.bin` using Electron `safeStorage`. SQLite event history and minute traffic samples are stored at `%APPDATA%\queuepulse-ai\queuepulse.sqlite3`; evidence snapshots are stored alongside it in `%APPDATA%\queuepulse-ai\evidence\`. Frames are processed locally and are not uploaded.

Electron keeps context isolation enabled, renderer Node integration disabled, and renderer sandboxing enabled. React receives only a narrow preload bridge; Electron validates renderer senders and IPC payload sizes. Windows video devices are previewed in the renderer; RTSP sources are captured by a separate OpenCV process. Both send frames to the same centralized local AI worker.

## Camera test suite and local RTSP stream

Run the automated checks from PowerShell:

```powershell
npm test
```

These tests exercise local TCP reachability/refusal using real sockets, RTSP URL/credential validation, simulated authentication/path/codec/network error classification, missing/stale/black/low-FPS health checks, and worker analytics. They are simulated software checks, not tests against a customer CCTV/NVR or proof that a particular codec/authentication mode works. Process-crash recovery, full multi-camera hardware operation, camera switching, and restart restoration still require integration validation against the packaged app and available devices.

For a local end-to-end RTSP test, use a local MediaMTX executable and FFmpeg installation (not bundled with QueuePulse):

```powershell
# Terminal 1: start MediaMTX with its default local RTSP listener on port 8554
.\mediamtx.exe

# Terminal 2: publish actual generated H.264 frames to that local RTSP server
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=15 -c:v libx264 -preset ultrafast -tune zerolatency -f rtsp rtsp://127.0.0.1:8554/queuepulse
```

In Camera discovery, save `rtsp://127.0.0.1:8554/queuepulse` as a manual RTSP profile, then use **Camera diagnostics → Test connection**. This uses a real local RTSP server and decoded frames; the generated image is only a software test source, not a physical camera. Stop the publisher/server to simulate interruption/offline behavior; use a different local port for a refused-port simulation. H.265/low-FPS simulations depend on the locally installed FFmpeg encoder and OpenCV decoder.

## Windows installer validation

Build the unsigned NSIS installer with `npm run dist:win`, then install it on a clean Windows account/device and verify that the `resources\worker` folder contains `worker.py`, `camera_source.py`, `requirements.txt`, and `setup_model.py`. The installer currently does **not** bundle/provision Python, OpenCV/FFmpeg, PyTorch/Ultralytics, or YOLO weights. Complete **First-time AI setup** after installation, launch the app, and test a USB camera plus the customer’s actual camera/NVR before deployment. `npm run dist:win` packaging success alone does not validate camera drivers, Windows Firewall, ONVIF multicast, authentication, codec availability, or live inference.

The model and Ultralytics dependencies are subject to their respective licenses. Review those terms for your intended use.

## Limitations

- ONVIF network discovery requires WS-Discovery to be enabled and permitted on the local network. Network discovery does not scan arbitrary IPs or vendor-specific discovery protocols.
- ONVIF channel enumeration depends on the recorder exposing media profiles and stream URIs through ONVIF. Vendor-specific NVR/DVR APIs are not implemented; some recorders require per-channel credentials or configuration.
- RTSP streams must use a private IPv4 endpoint, return an RTSP URI at the discovered device's IP, and be supported by the installed OpenCV/FFmpeg build. Some camera-specific URL paths, transport modes, TLS variants, or authentication schemes may not work.
- Authentication/path/codec diagnoses use TCP reachability and available OpenCV/FFmpeg error output. Some builds suppress those details, so a failed stream may be reported as a generic no-frame or connection error rather than a definitive authentication/path diagnosis.
- Camera CPU information is a short system-wide sample; memory diagnostics include system free/total memory and Electron main-process RSS, not isolated per-camera decoder or Python-worker memory.
- Multiple USB and RTSP streams can remain connected independently up to the configured connection limit. Live Monitor shows one preview at a time, and the current AI worker analyzes the selected preview stream.
- Startup auto-reconnect currently restores saved RTSP streams only. USB camera capture uses Electron's renderer camera permission and must be started again after an application restart.
- A computer monitor does not expose camera streams. Video available only over HDMI requires an HDMI capture card; QueuePulse can use it only if Windows exposes it as a video input and it receives a camera signal.
- Windows device enumeration depends on Windows privacy permissions. Some device names appear only after permission is granted.
- Windows' browser camera API does not expose reliable manufacturer/model fields for every USB device; the app displays the Windows-provided device label instead.
- Detection and tracking quality varies with camera angle, lighting, occlusion, and model performance. Queue and crowd membership use bounding-box intersection with configurable rectangles. Restricted/loitering zones are currently rectangular; polygon editing and calibration are not included.
- ByteTrack IDs are session-scoped. Footfall and entry/exit totals persist, but tracking identities do not persist across worker restarts.
- Minute samples are retained for 24 hours in the analytics query; alert history is retained locally. The saved retention preference does not yet trigger automatic cleanup.
- Sound notifications play a short local tone when a new alert is generated; email delivery is not implemented.
- Physical camera access, DroidCam device selection, live model inference, and accuracy need verification on a Windows machine with the target camera and configured Python/model environment.
