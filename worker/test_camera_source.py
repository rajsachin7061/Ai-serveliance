import unittest

from worker.camera_source import authenticated_rtsp_url, valid_rtsp_url


class CameraSourceTests(unittest.TestCase):
    def test_accepts_local_virtual_rtsp_endpoint(self):
        self.assertTrue(valid_rtsp_url("rtsp://127.0.0.1:8554/live/main"))

    def test_rejects_invalid_or_embedded_credential_urls(self):
        for value in (
            "http://192.168.1.25/video",
            "rtsp://8.8.8.8/live",
            "rtsp://viewer:secret@192.168.1.25/live",
            "rtsp://192.168.1.25:99999/live",
        ):
            self.assertFalse(valid_rtsp_url(value), value)

    def test_escapes_credentials_only_for_the_capture_connection(self):
        result = authenticated_rtsp_url("rtsp://192.168.1.25/live", "viewer", "p@ss")
        self.assertEqual(result, "rtsp://viewer:p%40ss@192.168.1.25/live")
        self.assertNotIn("p@ss", result)


if __name__ == "__main__":
    unittest.main()
