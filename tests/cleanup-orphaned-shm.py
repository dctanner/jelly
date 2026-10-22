#!/usr/bin/python3
"""Non-destructive cleanup-policy tests. Kernel IPC mutations are always mocked."""
import contextlib
from dataclasses import replace
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("shm_cleanup", Path(__file__).resolve().parents[1] / "scripts/cleanup-orphaned-shm.py")
cleanup = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = cleanup
spec.loader.exec_module(cleanup)
BASE = cleanup.Segment(id=42, key=0, uid=1000, cuid=1000, perms=0o600, size=4096,
                       nattch=0, cpid=100, lpid=101, ctime=10, atime=30, dtime=40)


class CleanupPolicy(unittest.TestCase):
    def eligible(self, segment=BASE, **kwargs):
        return cleanup.eligible(segment, uid=1000, now=1000, min_age=300,
                                dead=kwargs.get("dead", lambda pid: pid in (100, 101)))

    def test_only_old_own_private_unattached_segments_qualify(self):
        self.assertTrue(self.eligible())
        for field, value in [("key", 123), ("uid", 1001), ("cuid", 1001),
                             ("perms", 0o666), ("nattch", 1), ("ctime", 0),
                             ("ctime", 900), ("atime", 900), ("dtime", 900),
                             ("cpid", 0), ("lpid", 0), ("cpid", 1), ("lpid", 1)]:
            with self.subTest(field=field, value=value):
                self.assertFalse(self.eligible(replace(BASE, **{field: value})))

    def test_five_minute_age_boundary(self):
        self.assertTrue(self.eligible(replace(BASE, dtime=700)))
        self.assertFalse(self.eligible(replace(BASE, dtime=701)))

    def test_live_or_unknown_process_is_preserved(self):
        self.assertFalse(self.eligible(dead=lambda pid: pid == 100))
        self.assertFalse(self.eligible(dead=lambda pid: pid == 101))
        with patch.object(cleanup.os, "kill", side_effect=PermissionError):
            self.assertFalse(cleanup.process_dead(100))
        with patch.object(cleanup.os, "kill", return_value=None):
            self.assertFalse(cleanup.process_dead(100))
        with patch.object(cleanup.os, "kill", side_effect=ProcessLookupError):
            self.assertTrue(cleanup.process_dead(100))

    def attempt(self, current=BASE, dead=lambda pid: True, removed=None):
        removed = [] if removed is None else removed
        result = cleanup.remove_if_unchanged(BASE, 1000, 300, query=lambda _: current,
            dead=dead, clock=lambda: 1000, remove=lambda ident: removed.append(ident) or True)
        return result, removed

    def test_unchanged_segment_removed_by_exact_id(self):
        self.assertEqual(self.attempt([BASE]), (True, [42]))

    def test_every_metadata_change_blocks_removal(self):
        for field in BASE.__dataclass_fields__:
            with self.subTest(field=field):
                changed = replace(BASE, **{field: getattr(BASE, field) + 1})
                self.assertEqual(self.attempt([changed]), (False, []))

    def test_missing_or_ambiguous_id_blocks_removal(self):
        self.assertEqual(self.attempt([]), (False, []))
        self.assertEqual(self.attempt([BASE, BASE]), (False, []))

    def test_new_attachment_or_pid_reuse_blocks_removal(self):
        self.assertEqual(self.attempt([replace(BASE, nattch=1)]), (False, []))
        self.assertEqual(self.attempt([BASE], dead=lambda _: False), (False, []))

    def test_failed_removal_is_not_reported_as_success(self):
        self.assertFalse(cleanup.remove_if_unchanged(BASE, 1000, 300,
            query=lambda _: [BASE], dead=lambda _: True, clock=lambda: 1000, remove=lambda _: False))

    def test_default_is_dry_run_and_reports_are_owner_only(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "report.json"
            with patch.object(sys, "argv", ["cleanup", "--report", str(report)]), \
                 patch.object(cleanup.os, "getuid", return_value=1000), \
                 patch.object(cleanup.os, "geteuid", return_value=1000), \
                 patch.object(cleanup, "inspect", return_value=[BASE]), \
                 patch.object(cleanup, "eligible", return_value=True), \
                 patch.object(cleanup, "remove_if_unchanged") as remove, \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cleanup.main(), 0)
                remove.assert_not_called()
            result = json.loads(report.read_text())
            self.assertEqual(result["mode"], "dry-run")
            self.assertEqual(result["candidate_ids"], [42])
            self.assertEqual(result["removed_ids"], [])
            self.assertEqual(report.stat().st_mode & 0o777, 0o600)

    def test_root_and_too_short_age_are_refused(self):
        for uid, age in [(0, 300), (1000, 0), (1000, 59), (1000, 60), (1000, 299)]:
            with patch.object(sys, "argv", ["cleanup", "--apply", "--min-age", str(age)]), \
                 patch.object(cleanup.os, "getuid", return_value=uid), \
                 patch.object(cleanup.os, "geteuid", return_value=uid), \
                 patch.object(cleanup, "inspect") as inspect, \
                 contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit): cleanup.main()
                inspect.assert_not_called()

    def test_existing_or_symlink_report_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "target"
            target.write_text("preserve")
            link = Path(directory) / "link"
            link.symlink_to(target)
            for path in (target, link):
                with patch.object(sys, "argv", ["cleanup", "--apply", "--report", str(path)]), \
                     patch.object(cleanup.os, "getuid", return_value=1000), \
                     patch.object(cleanup.os, "geteuid", return_value=1000), \
                     patch.object(cleanup, "inspect") as inspect:
                    with self.assertRaises(FileExistsError): cleanup.main()
                    inspect.assert_not_called()
            self.assertEqual(target.read_text(), "preserve")


if __name__ == "__main__":
    unittest.main()
