import sqlite3
import tempfile
import unittest
from pathlib import Path

from worker.camera_source import authenticated_rtsp_url, valid_rtsp_url
from worker.worker import Analytics, acknowledge, crosses_line, history, normalize_config, normalize_rect, open_database, record_system_alert


class WorkerAnalyticsTests(unittest.TestCase):
    def test_rtsp_source_requires_a_credential_free_rtsp_endpoint(self):
        self.assertTrue(valid_rtsp_url("rtsp://192.168.1.25:554/stream1"))
        self.assertFalse(valid_rtsp_url("http://192.168.1.25/video"))
        self.assertFalse(valid_rtsp_url("rtsp://user:password@192.168.1.25/stream1"))
        self.assertFalse(valid_rtsp_url("rtsp://192.168.1.25/stream1#fragment"))
        self.assertFalse(valid_rtsp_url("rtsp://8.8.8.8/stream1"))
        self.assertEqual(
            authenticated_rtsp_url("rtsp://192.168.1.25/stream1", "viewer", "p@ss"),
            "rtsp://viewer:p%40ss@192.168.1.25/stream1",
        )

    def test_counting_line_detects_only_segment_crossings(self):
        line = {"x1": 0.5, "y1": 0.2, "x2": 0.5, "y2": 0.8}
        self.assertTrue(crosses_line((0.4, 0.5), (0.6, 0.5), line)[0])
        self.assertFalse(crosses_line((0.4, 0.1), (0.6, 0.1), line)[0])

    def test_rectangle_is_bounded_to_frame(self):
        rect = normalize_rect({"x": 0.9, "y": 0.9, "width": 1, "height": 1})
        self.assertAlmostEqual(rect["width"], 0.1)
        self.assertAlmostEqual(rect["height"], 0.1)
        self.assertEqual((rect["x"], rect["y"]), (0.9, 0.9))

    def test_worker_configuration_applies_safe_defaults_and_confidence(self):
        config = normalize_config({
            "confidence": 0.8,
            "restrictedZones": [{"id": "back", "name": "Back room", "x": 0.2, "y": 0.1, "width": 0.3, "height": 0.4}],
        })
        self.assertEqual(config["confidence"], 0.8)
        self.assertEqual(config["restrictedZones"][0]["name"], "Back room")
        self.assertEqual(config["queueZone"], {"x": 0.2, "y": 0.6, "width": 0.6, "height": 0.35})

    def test_system_alert_persists_and_can_be_acknowledged(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "events.sqlite3"
            alert = record_system_alert(database, "camera_disconnected", "Camera stream ended.", "DroidCam Video")
            self.assertTrue(acknowledge(database, alert["id"], "acknowledge"))
            stored = history(database)
            self.assertEqual(stored["alerts"][0]["type"], "camera_disconnected")
            self.assertTrue(stored["alerts"][0]["acknowledged"])
            self.assertEqual(stored["totals"]["footfall"], 0)
            connection = sqlite3.connect(database)
            self.assertTrue(connection.execute("SELECT 1 FROM alerts WHERE id = ?", (alert["id"],)).fetchone())
            connection.close()

    def test_history_includes_camera_association_and_timestamped_window_events(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "events.sqlite3"
            alert = record_system_alert(
                database, "camera_disconnected", "Camera stream ended.", "Front door", "camera-front",
            )
            stored = history(database)
            self.assertEqual(stored["alerts"][0]["cameraId"], "camera-front")
            self.assertEqual(stored["windowEvents"][0]["id"], alert["id"])
            self.assertEqual(stored["windowEvents"][0]["cameraId"], "camera-front")

    def test_legacy_traffic_is_preserved_in_camera_scoped_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "legacy.sqlite3"
            connection = sqlite3.connect(database)
            connection.execute(
                """CREATE TABLE traffic (
                    minute TEXT PRIMARY KEY, people INTEGER NOT NULL, queue INTEGER NOT NULL,
                    crowd INTEGER NOT NULL, occupancy INTEGER NOT NULL, fps REAL NOT NULL
                )"""
            )
            connection.execute(
                "INSERT INTO traffic VALUES (?, 4, 1, 0, 3, 5.0)",
                ("2026-11-04T05:30",),
            )
            connection.commit()
            connection.close()

            stored = history(database)
            self.assertEqual(stored["traffic"][0]["camera_id"], "legacy")
            self.assertEqual(stored["traffic"][0]["people"], 4)
            connection = sqlite3.connect(database)
            primary_key = [row[1] for row in sorted(
                (row for row in connection.execute("PRAGMA table_info(traffic)") if row[5]),
                key=lambda row: row[5],
            )]
            connection.close()
            self.assertEqual(primary_key, ["camera_id", "minute"])

    def test_camera_analytics_totals_are_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "camera-totals.sqlite3"
            connection = open_database(database)
            analytics = Analytics(connection, Path(directory) / "evidence")
            analytics.increment_camera_total("camera-1", "entries")
            analytics.increment_camera_total("camera-1", "entries")
            analytics.increment_camera_total("camera-2", "entries")
            connection.commit()
            connection.close()

            totals = history(database)["cameraTotals"]
            self.assertEqual(totals["camera-1"]["entries"], 2)
            self.assertEqual(totals["camera-2"]["entries"], 1)


if __name__ == "__main__":
    unittest.main()
