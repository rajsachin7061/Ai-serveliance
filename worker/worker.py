import argparse
import base64
import json
import math
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path


def emit(message):
    print(json.dumps(message, separators=(",", ":")), flush=True)


def number(value, fallback, low=0.0, high=1.0):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return min(high, max(low, result)) if math.isfinite(result) else fallback


def normalize_rect(rect, fallback=None):
    rect = rect if isinstance(rect, dict) else fallback or {}
    x = number(rect.get("x"), 0.2)
    y = number(rect.get("y"), 0.6)
    width = number(rect.get("width"), 0.6, 0.01)
    height = number(rect.get("height"), 0.35, 0.01)
    width = min(width, 1 - x)
    height = min(height, 1 - y)
    return {"x": x, "y": y, "width": width, "height": height}


def box_intersects_rect(box, rect):
    return (
        box["x"] < rect["x"] + rect["width"]
        and box["x"] + box["width"] > rect["x"]
        and box["y"] < rect["y"] + rect["height"]
        and box["y"] + box["height"] > rect["y"]
    )


def center(box):
    return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2


def line_side(point, line):
    return (point[0] - line["x1"]) * (line["y2"] - line["y1"]) - (point[1] - line["y1"]) * (line["x2"] - line["x1"])


def crosses_line(previous, current, line):
    before_side = line_side(previous, line)
    current_side = line_side(current, line)
    if before_side * current_side >= 0:
        return False, current_side
    travel = (current[0] - previous[0], current[1] - previous[1])
    segment = (line["x2"] - line["x1"], line["y2"] - line["y1"])
    denominator = travel[0] * segment[1] - travel[1] * segment[0]
    if abs(denominator) < 1e-9:
        return False, current_side
    offset = (line["x1"] - previous[0], line["y1"] - previous[1])
    along_travel = (offset[0] * segment[1] - offset[1] * segment[0]) / denominator
    along_line = (offset[0] * travel[1] - offset[1] * travel[0]) / denominator
    return 0 <= along_travel <= 1 and 0 <= along_line <= 1, current_side


def normalize_config(config):
    config = config if isinstance(config, dict) else {}
    queue_zone = normalize_rect(config.get("queueZone"))
    line_in = config.get("countingLine") if isinstance(config.get("countingLine"), dict) else {}
    line = {
        "x1": number(line_in.get("x1"), 0.5),
        "y1": number(line_in.get("y1"), 0.2),
        "x2": number(line_in.get("x2"), 0.5),
        "y2": number(line_in.get("y2"), 0.8),
        "positiveIsEntry": bool(line_in.get("positiveIsEntry", True)),
    }
    if math.hypot(line["x2"] - line["x1"], line["y2"] - line["y1"]) < 0.05:
        line = {"x1": 0.5, "y1": 0.2, "x2": 0.5, "y2": 0.8, "positiveIsEntry": True}

    def zones(key, max_count=12):
        result = []
        source = config.get(key, [])
        if not isinstance(source, list):
            return result
        for index, zone in enumerate(source[:max_count]):
            if not isinstance(zone, dict):
                continue
            result.append({
                "id": str(zone.get("id", f"{key}-{index + 1}"))[:60],
                "name": str(zone.get("name", f"Zone {index + 1}"))[:60],
                **normalize_rect(zone),
                "thresholdSeconds": int(number(zone.get("thresholdSeconds"), 60, 5, 3600)),
                "maxOccupancy": int(number(zone.get("maxOccupancy"), 10, 1, 10000)),
            })
        return result

    return {
        "cameraId": str(config.get("cameraId", ""))[:60],
        "cameraName": str(config.get("cameraName", "Camera"))[:80],
        "alertsEnabled": config.get("alertsEnabled", True) is not False,
        "confidence": number(config.get("confidence"), 0.35, 0.1, 0.95),
        "queueZone": queue_zone,
        "countingLine": line,
        "restrictedZones": zones("restrictedZones"),
        "loiteringZones": zones("loiteringZones"),
        "crowdZones": zones("crowdZones"),
    }


def open_database(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute(
        "CREATE TABLE IF NOT EXISTS totals (key TEXT PRIMARY KEY, value INTEGER NOT NULL)"
    )
    connection.executemany(
        "INSERT OR IGNORE INTO totals (key, value) VALUES (?, 0)",
        [("footfall",), ("entries",), ("exits",)],
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS camera_totals (
            camera_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value INTEGER NOT NULL,
            PRIMARY KEY (camera_id, key)
        )"""
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS alerts (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            severity TEXT NOT NULL,
            title TEXT NOT NULL,
            detail TEXT NOT NULL,
            camera TEXT NOT NULL,
            camera_id TEXT NOT NULL DEFAULT '',
            timestamp TEXT NOT NULL,
            tracking_id TEXT,
            zone TEXT,
            evidence_path TEXT,
            acknowledged INTEGER NOT NULL DEFAULT 0,
            resolved INTEGER NOT NULL DEFAULT 0
        )"""
    )
    alert_columns = {row[1] for row in connection.execute("PRAGMA table_info(alerts)")}
    if "camera_id" not in alert_columns:
        connection.execute("ALTER TABLE alerts ADD COLUMN camera_id TEXT NOT NULL DEFAULT ''")
    connection.execute(
        """CREATE TABLE IF NOT EXISTS traffic (
            camera_id TEXT NOT NULL DEFAULT '',
            minute TEXT NOT NULL,
            people INTEGER NOT NULL,
            queue INTEGER NOT NULL,
            crowd INTEGER NOT NULL,
            occupancy INTEGER NOT NULL,
            fps REAL NOT NULL,
            entries INTEGER NOT NULL DEFAULT 0,
            exits INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (camera_id, minute)
        )"""
    )
    columns = {row[1] for row in connection.execute("PRAGMA table_info(traffic)")}
    if "entries" not in columns:
        connection.execute("ALTER TABLE traffic ADD COLUMN entries INTEGER NOT NULL DEFAULT 0")
    if "exits" not in columns:
        connection.execute("ALTER TABLE traffic ADD COLUMN exits INTEGER NOT NULL DEFAULT 0")
    primary_key = [row[1] for row in sorted(
        (row for row in connection.execute("PRAGMA table_info(traffic)") if row[5]),
        key=lambda row: row[5],
    )]
    if primary_key != ["camera_id", "minute"]:
        connection.execute("ALTER TABLE traffic RENAME TO traffic_legacy")
        connection.execute(
            """CREATE TABLE traffic (
                camera_id TEXT NOT NULL DEFAULT '',
                minute TEXT NOT NULL,
                people INTEGER NOT NULL,
                queue INTEGER NOT NULL,
                crowd INTEGER NOT NULL,
                occupancy INTEGER NOT NULL,
                fps REAL NOT NULL,
                entries INTEGER NOT NULL DEFAULT 0,
                exits INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (camera_id, minute)
            )"""
        )
        connection.execute(
            """INSERT INTO traffic
            (camera_id, minute, people, queue, crowd, occupancy, fps, entries, exits)
            SELECT 'legacy', minute, people, queue, crowd, occupancy, fps, entries, exits
            FROM traffic_legacy"""
        )
        connection.execute("DROP TABLE traffic_legacy")
    connection.execute("CREATE INDEX IF NOT EXISTS alerts_timestamp_idx ON alerts(timestamp)")
    connection.execute("CREATE INDEX IF NOT EXISTS alerts_camera_timestamp_idx ON alerts(camera_id, timestamp)")
    connection.commit()
    return connection


def save_evidence(cv2, image, folder, event_id):
    folder.mkdir(parents=True, exist_ok=True)
    height, width = image.shape[:2]
    ratio = min(1.0, 960 / max(width, height))
    snapshot = cv2.resize(image, (max(1, int(width * ratio)), max(1, int(height * ratio))))
    ok, encoded = cv2.imencode(".jpg", snapshot, [cv2.IMWRITE_JPEG_QUALITY, 78])
    if not ok:
        return None, None
    path = folder / f"{event_id}.jpg"
    path.write_bytes(encoded.tobytes())
    return str(path), "data:image/jpeg;base64," + base64.b64encode(encoded).decode("ascii")


def history(database_path):
    connection = open_database(database_path)
    connection.row_factory = sqlite3.Row
    try:
        totals = {row["key"]: row["value"] for row in connection.execute("SELECT key, value FROM totals")}
        alerts = [{
            "id": row["id"], "type": row["type"], "severity": row["severity"],
            "title": row["title"], "detail": row["detail"], "camera": row["camera"],
            "cameraId": row["camera_id"], "timestamp": row["timestamp"], "trackingId": row["tracking_id"],
            "zone": row["zone"], "evidencePath": row["evidence_path"],
            "acknowledged": bool(row["acknowledged"]), "resolved": bool(row["resolved"]),
        } for row in connection.execute("SELECT * FROM alerts ORDER BY timestamp DESC LIMIT 100")]
        traffic = [dict(row) for row in connection.execute(
            "SELECT * FROM traffic ORDER BY minute DESC LIMIT 1440"
        )]
        camera_totals = {}
        for row in connection.execute("SELECT camera_id, key, value FROM camera_totals"):
            camera_totals.setdefault(row["camera_id"], {})[row["key"]] = row["value"]
        now = datetime.now(timezone.utc)
        cutoff = (now - timedelta(hours=1)).isoformat(timespec="seconds")
        now_timestamp = now.isoformat(timespec="seconds")
        window_events = [{
            "id": row["id"], "type": row["type"], "severity": row["severity"],
            "title": row["title"], "detail": row["detail"], "camera": row["camera"],
            "cameraId": row["camera_id"], "timestamp": row["timestamp"],
            "trackingId": row["tracking_id"], "zone": row["zone"],
            "acknowledged": bool(row["acknowledged"]), "resolved": bool(row["resolved"]),
        } for row in connection.execute(
            """SELECT * FROM alerts
            WHERE timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC""",
            (cutoff, now_timestamp),
        )]
        hourly = [dict(row) for row in connection.execute(
            """SELECT substr(timestamp, 1, 13) AS period,
                SUM(CASE WHEN detail LIKE '%(entry)%' THEN 1 ELSE 0 END) AS entries,
                SUM(CASE WHEN detail LIKE '%(exit)%' THEN 1 ELSE 0 END) AS exits
            FROM alerts WHERE type = 'entry_exit'
            GROUP BY period ORDER BY period DESC LIMIT 24"""
        )]
        daily = [dict(row) for row in connection.execute(
            """SELECT substr(timestamp, 1, 10) AS period,
                SUM(CASE WHEN detail LIKE '%(entry)%' THEN 1 ELSE 0 END) AS entries,
                SUM(CASE WHEN detail LIKE '%(exit)%' THEN 1 ELSE 0 END) AS exits,
                COUNT(DISTINCT CASE WHEN detail LIKE '%(entry)%' THEN tracking_id END) AS unique_footfall
            FROM alerts WHERE type = 'entry_exit'
            GROUP BY period ORDER BY period DESC LIMIT 30"""
        )]
        return {
            "totals": totals, "alerts": alerts, "traffic": list(reversed(traffic)),
            "hourly": list(reversed(hourly)), "daily": list(reversed(daily)),
            "windowEvents": window_events,
            "cameraTotals": camera_totals,
        }
    finally:
        connection.close()


def acknowledge(database_path, alert_id, action):
    if not alert_id or len(alert_id) > 80 or action not in ("acknowledge", "resolve"):
        raise ValueError("Invalid alert update.")
    connection = sqlite3.connect(database_path)
    try:
        column = "acknowledged" if action == "acknowledge" else "resolved"
        cursor = connection.execute(f"UPDATE alerts SET {column} = 1 WHERE id = ?", (alert_id,))
        connection.commit()
        return cursor.rowcount > 0
    finally:
        connection.close()


def record_system_alert(database_path, kind, detail, camera, camera_id=""):
    allowed = {
        "camera_disconnected": ("high", "Camera disconnected"),
        "ai_worker_disconnected": ("high", "AI worker disconnected"),
        "detection_failure": ("medium", "AI detection failure"),
    }
    if kind not in allowed:
        raise ValueError("Invalid system alert type.")
    severity, title = allowed[kind]
    event = {
        "id": str(uuid.uuid4()),
        "type": kind,
        "severity": severity,
        "title": title,
        "detail": detail[:300],
        "camera": camera[:80],
        "cameraId": camera_id[:60],
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "trackingId": None,
        "zone": None,
        "evidencePath": None,
        "acknowledged": False,
        "resolved": False,
    }
    connection = open_database(database_path)
    try:
        connection.execute(
            """INSERT INTO alerts
            (id, type, severity, title, detail, camera, camera_id, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (event["id"], kind, severity, title, event["detail"], event["camera"],
             event["cameraId"], event["timestamp"]),
        )
        connection.commit()
        return event
    finally:
        connection.close()


class Analytics:
    def __init__(self, connection, evidence_dir):
        self.db = connection
        self.evidence_dir = evidence_dir
        self.previous = {}
        self.last_crossing = {}
        self.footfall_counted = set()
        self.zone_presence = {}
        self.last_seen = {}
        self.last_alert_state = set()
        self.active_camera_id = None
        self.camera_totals = {}
        self.last_traffic_minute = None
        self.fps_started = time.monotonic()
        self.fps_frames = 0
        self.fps = 0.0
        totals = dict(self.db.execute("SELECT key, value FROM totals"))
        self.footfall = totals.get("footfall", 0)
        self.entries = totals.get("entries", 0)
        self.exits = totals.get("exits", 0)

    def increment_camera_total(self, camera_id, key):
        self.db.execute(
            """INSERT INTO camera_totals (camera_id, key, value) VALUES (?, ?, 1)
            ON CONFLICT(camera_id, key) DO UPDATE SET value = value + 1""",
            (camera_id, key),
        )
        self.camera_totals[key] = self.camera_totals.get(key, 0) + 1

    def event(self, kind, severity, title, detail, config, track_id, zone, image, cv2):
        event_id = str(uuid.uuid4())
        timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        evidence_path, evidence = save_evidence(cv2, image, self.evidence_dir, event_id)
        self.db.execute(
            """INSERT INTO alerts
            (id, type, severity, title, detail, camera, camera_id, timestamp, tracking_id, zone, evidence_path)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (event_id, kind, severity, title, detail, config["cameraName"], config["cameraId"], timestamp,
             None if track_id is None else str(track_id), zone, evidence_path),
        )
        return {
            "id": event_id, "type": kind, "severity": severity, "title": title,
            "detail": detail, "camera": config["cameraName"], "timestamp": timestamp,
            "trackingId": None if track_id is None else str(track_id),
            "zone": zone, "evidencePath": evidence_path, "evidence": evidence,
            "acknowledged": False, "resolved": False,
        }

    def process(self, detections, config, image, cv2, width, height):
        camera_id = config["cameraId"]
        if camera_id != self.active_camera_id:
            self.active_camera_id = camera_id
            self.camera_totals = dict(self.db.execute(
                "SELECT key, value FROM camera_totals WHERE camera_id = ?", (camera_id,)
            ))
            self.previous.clear()
            self.last_crossing.clear()
            self.footfall_counted.clear()
            self.zone_presence.clear()
            self.last_seen.clear()
            self.last_alert_state.clear()
        now = time.monotonic()
        self.fps_frames += 1
        elapsed = now - self.fps_started
        if elapsed >= 2:
            self.fps = self.fps_frames / elapsed
            self.fps_frames = 0
            self.fps_started = now

        events = []
        queue_count = 0
        restricted_active = set()
        loiter_active = set()
        crowd_state = set()

        for person in detections:
            track_id = person["trackingId"]
            point = center(person)
            if box_intersects_rect(person, config["queueZone"]):
                queue_count += 1

            if track_id is not None:
                track_key = str(track_id)
                self.last_seen[track_key] = now
                previous = self.previous.get(track_key)
                if previous:
                    crossed, current_side = crosses_line(previous, point, config["countingLine"])
                    last_crossing = self.last_crossing.get(track_key, 0)
                    if crossed and now - last_crossing >= 1.5:
                        self.last_crossing[track_key] = now
                        entered = (current_side > 0) == config["countingLine"]["positiveIsEntry"]
                        if entered:
                            self.entries += 1
                            self.increment_camera_total(camera_id, "entries")
                            if track_key not in self.footfall_counted:
                                self.footfall += 1
                                self.increment_camera_total(camera_id, "footfall")
                                self.footfall_counted.add(track_key)
                            direction = "entry"
                        else:
                            self.exits += 1
                            self.increment_camera_total(camera_id, "exits")
                            direction = "exit"
                        self.db.execute("UPDATE totals SET value = ? WHERE key = 'entries'", (self.entries,))
                        self.db.execute("UPDATE totals SET value = ? WHERE key = 'exits'", (self.exits,))
                        self.db.execute("UPDATE totals SET value = ? WHERE key = 'footfall'", (self.footfall,))
                        events.append(self.event(
                            "entry_exit", "low", f"Person {direction}",
                            f"Tracked person crossed the counting line ({direction}).",
                            config, track_id, "Counting line", image, cv2,
                        ))
                self.previous[track_key] = point

            for zone in config["restrictedZones"]:
                if box_intersects_rect(person, zone):
                    key = ("restricted", zone["id"], track_id)
                    restricted_active.add(key)
                    if config["alertsEnabled"] and track_id is not None and key not in self.zone_presence:
                        events.append(self.event(
                            "restricted_intrusion", "high", "Restricted area intrusion",
                            f"Tracked person entered {zone['name']}.", config, track_id,
                            zone["name"], image, cv2,
                        ))

            for zone in config["loiteringZones"]:
                if box_intersects_rect(person, zone):
                    key = ("loitering", zone["id"], track_id)
                    loiter_active.add(key)
                    first_seen = self.zone_presence.get(key)
                    if first_seen is None:
                        self.zone_presence[key] = now
                    elif config["alertsEnabled"] and track_id is not None and now - first_seen >= zone["thresholdSeconds"] and not self.zone_presence.get((key, "alerted")):
                        self.zone_presence[(key, "alerted")] = True
                        events.append(self.event(
                            "loitering", "medium", "Loitering threshold reached",
                            f"Tracked person remained in {zone['name']} for {int(now - first_seen)} seconds.",
                            config, track_id, zone["name"], image, cv2,
                        ))

        crowd_count = 0
        crowd_percent = 0
        crowd_status = "normal"
        for zone in config["crowdZones"]:
            count = sum(1 for person in detections if box_intersects_rect(person, zone))
            percent = round(count / zone["maxOccupancy"] * 100)
            if percent > crowd_percent:
                crowd_percent = percent
                crowd_count = count
            if percent >= 100:
                crowd_status = "critical"
            elif percent >= 80 and crowd_status != "critical":
                crowd_status = "warning"
            key = ("crowd", zone["id"])
            if count >= zone["maxOccupancy"]:
                crowd_state.add(key)
                if config["alertsEnabled"] and key not in self.last_alert_state:
                    events.append(self.event(
                        "crowd_threshold", "critical", "Crowd capacity reached",
                        f"{count} people detected in {zone['name']} (limit {zone['maxOccupancy']}).",
                        config, None, zone["name"], image, cv2,
                    ))
        self.last_alert_state = crowd_state

        current_presence = restricted_active | loiter_active
        for key in list(self.zone_presence):
            if isinstance(key, tuple) and len(key) == 3 and key not in current_presence:
                self.zone_presence.pop(key, None)
                self.zone_presence.pop((key, "alerted"), None)
        for track_key, seen in list(self.last_seen.items()):
            if now - seen > 30:
                self.last_seen.pop(track_key, None)
                self.previous.pop(track_key, None)
                self.last_crossing.pop(track_key, None)
                self.footfall_counted.discard(track_key)
                for key in list(self.zone_presence):
                    if isinstance(key, tuple) and len(key) == 3 and key[2] == track_key:
                        self.zone_presence.pop(key, None)

        occupancy = self.entries - self.exits
        minute = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M")
        self.db.execute(
            """INSERT INTO traffic (camera_id, minute, people, queue, crowd, occupancy, fps, entries, exits)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(camera_id, minute) DO UPDATE SET
                people=excluded.people, queue=excluded.queue,
                crowd=excluded.crowd, occupancy=excluded.occupancy, fps=excluded.fps,
                entries=excluded.entries, exits=excluded.exits""",
            (camera_id, minute, len(detections), queue_count, crowd_count, occupancy, self.fps,
             self.camera_totals.get("entries", 0), self.camera_totals.get("exits", 0)),
        )
        self.last_traffic_minute = minute
        self.db.commit()

        return {
            "type": "detection",
            "peopleCount": len(detections),
            "queueCount": queue_count,
            "crowdCount": crowd_count,
            "crowdPercent": crowd_percent,
            "crowdStatus": crowd_status,
            "occupancy": occupancy,
            "footfall": self.footfall,
            "entries": self.entries,
            "exits": self.exits,
            "fps": round(self.fps, 1),
            "detections": detections,
            "frameWidth": width,
            "frameHeight": height,
            "events": events,
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--evidence-dir", type=Path)
    parser.add_argument("--history", action="store_true")
    parser.add_argument("--acknowledge")
    parser.add_argument("--resolve")
    parser.add_argument("--system-alert", nargs=3, metavar=("TYPE", "DETAIL", "CAMERA"))
    parser.add_argument("--camera-id", default="")
    args = parser.parse_args()
    if not args.database:
        parser.error("--database is required")
    if args.history:
        emit({"type": "history", **history(args.database)})
        return 0
    if args.acknowledge or args.resolve:
        alert_id = args.acknowledge or args.resolve
        action = "acknowledge" if args.acknowledge else "resolve"
        emit({"type": "alert_updated", "updated": acknowledge(args.database, alert_id, action)})
        return 0
    if args.system_alert:
        emit({"type": "system_alert", "event": record_system_alert(args.database, *args.system_alert, args.camera_id)})
        return 0
    if not args.model:
        parser.error("--model is required")
    if not args.model.is_file():
        emit({
            "type": "error",
            "setupRequired": True,
            "message": (
                f"YOLOv8n model not found at {args.model}. "
                "Install worker requirements and run worker\\setup_model.py "
                "with this path as --output."
            ),
        })
        return 2
    try:
        import cv2
        import numpy as np
        from ultralytics import YOLO
    except ImportError as error:
        emit({
            "type": "error",
            "setupRequired": True,
            "message": (
                f"Missing Python dependency: {error.name}. "
                "Run py -3 -m pip install -r worker\\requirements.txt."
            ),
        })
        return 2
    try:
        model = YOLO(str(args.model), task="detect")
    except Exception as error:
        emit({"type": "error", "message": f"Could not load YOLO model: {error}"})
        return 2

    connection = open_database(args.database)
    analytics = Analytics(connection, args.evidence_dir or args.database.parent / "evidence")
    emit({"type": "ready", "totals": {
        "footfall": analytics.footfall, "entries": analytics.entries, "exits": analytics.exits,
    }})
    for line in sys.stdin:
        try:
            packet = json.loads(line)
            encoded = packet.get("image")
            if not isinstance(encoded, str) or len(encoded) > 700000:
                raise ValueError("Camera frame is missing or too large.")
            image_bytes = base64.b64decode(encoded, validate=True)
            image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError("Could not decode the camera frame.")
            config = normalize_config(packet.get("config"))
            height, width = image.shape[:2]
            started = time.monotonic()
            predictions = model.track(
                image, persist=True, tracker="bytetrack.yaml", classes=[0],
                conf=config["confidence"], imgsz=640, verbose=False,
            )
            inference_fps = 1 / max(time.monotonic() - started, 0.0001)
            people = []
            for prediction in predictions:
                boxes = prediction.boxes
                if boxes is None:
                    continue
                ids = boxes.id
                for index, box in enumerate(boxes):
                    x1, y1, x2, y2 = (float(value) for value in box.xyxy[0].tolist())
                    confidence = float(box.conf.item())
                    if confidence < config["confidence"] or int(box.cls.item()) != 0:
                        continue
                    tracking_id = int(ids[index].item()) if ids is not None else None
                    left, right = max(0, x1) / width, min(width, x2) / width
                    top, bottom = max(0, y1) / height, min(height, y2) / height
                    people.append({
                        "x": left, "y": top, "width": max(0, right - left),
                        "height": max(0, bottom - top), "confidence": confidence,
                        "trackingId": tracking_id,
                    })
            result = analytics.process(people, config, image, cv2, width, height)
            result["fps"] = round(inference_fps, 1)
            emit(result)
        except Exception as error:
            emit({"type": "frame_error", "message": str(error)})
    connection.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
