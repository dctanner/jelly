#!/usr/bin/python3
"""Explicit, current-user repair for abandoned private System V shared memory.

Dry-run by default. Never reads segment contents, kills processes, changes kernel
limits, or touches attached/named/foreign-user/recent segments. Not a daemon.
"""
import argparse
from dataclasses import dataclass
from datetime import datetime
import json
import os
import subprocess
import sys
import time

COLUMNS = "ID,KEY,UID,CUID,PERMS,SIZE,NATTCH,CPID,LPID,CTIME,ATTACH,DETACH"
ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "TZ": "UTC"}


@dataclass(frozen=True)
class Segment:
    id: int
    key: int
    uid: int
    cuid: int
    perms: int
    size: int
    nattch: int
    cpid: int
    lpid: int
    ctime: int
    atime: int
    dtime: int


def stamp(value):
    if value in (None, "", "-"):
        return 0
    return int(datetime.fromisoformat(value).timestamp())


def inspect(segment_id=None):
    args = ["/usr/bin/lsipc", "--shmems", "--json", "--bytes", "--numeric-perms",
            "--time-format", "iso", "--output", COLUMNS]
    if segment_id is not None:
        args += ["--id", str(segment_id)]
    result = subprocess.run(args, env=ENV, capture_output=True, timeout=15, check=False)
    # Missing/revoked IDs are skipped, not treated as permission to remove them.
    if result.returncode:
        if segment_id is not None:
            return []
        raise RuntimeError("Cannot inspect shared-memory metadata")
    values = json.loads(result.stdout).get("sharedmemory")
    if not isinstance(values, list):
        raise RuntimeError("Unexpected shared-memory metadata")
    return [Segment(
        id=int(v["id"]), key=int(v["key"], 16), uid=int(v["uid"]), cuid=int(v["cuid"]),
        perms=int(v["perms"], 8), size=int(v["size"]), nattch=int(v["nattch"]),
        cpid=int(v["cpid"]), lpid=int(v["lpid"]), ctime=stamp(v["ctime"]),
        atime=stamp(v["attach"]), dtime=stamp(v["detach"]),
    ) for v in values]


def process_dead(pid):
    if pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False  # Permission failure is not proof of process death.
    return False


def eligible(segment, uid, now, min_age, dead=process_dead):
    return (segment.key == 0 and segment.uid == uid and segment.cuid == uid and
            segment.perms == 0o600 and segment.nattch == 0 and segment.ctime > 0 and
            now - max(segment.ctime, segment.atime, segment.dtime) >= min_age and
            dead(segment.cpid) and dead(segment.lpid))


def remove_if_unchanged(original, uid, min_age, query=inspect, dead=process_dead,
                        clock=time.time, remove=None):
    current = query(original.id)
    if len(current) != 1 or current[0] != original:
        return False
    # Recheck attachment count, all identity/activity metadata and both PIDs
    # immediately before IPC_RMID. If somebody attaches in the residual kernel
    # race, IPC_RMID marks removal after the last detach, not an active unmap.
    if not eligible(current[0], uid, clock(), min_age, dead):
        return False
    if remove is None:
        result = subprocess.run(["/usr/bin/ipcrm", "--shmem-id", str(original.id)],
                                env=ENV, capture_output=True, timeout=5, check=False)
        return result.returncode == 0
    return remove(original.id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Remove eligible segments after a fresh per-ID recheck")
    parser.add_argument("--min-age", type=int, default=300, help="Minimum idle age in seconds (at least 300; default 300)")
    parser.add_argument("--report", help="Write a new owner-only JSON metadata report; existing files are refused")
    args = parser.parse_args()
    uid = os.getuid()
    if uid == 0 or uid != os.geteuid() or args.min_age < 300:
        parser.error("Run as the ordinary owning user (not sudo), with --min-age of at least 300 seconds")
    report_fd = None
    if args.report:
        report_fd = os.open(args.report, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    report = {"mode": "apply" if args.apply else "dry-run", "uid": uid,
              "min_age_seconds": args.min_age, "removed_ids": [], "skipped_ids": []}
    try:
        before = inspect()
        candidates = [s for s in before if eligible(s, uid, time.time(), args.min_age)]
        protected = [s.id for s in before if s.nattch > 0 or s.key != 0 or s.uid != uid or s.cuid != uid]
        report.update(before_count=len(before), candidate_count=len(candidates),
                      candidate_bytes=sum(s.size for s in candidates), candidate_ids=[s.id for s in candidates],
                      protected_ids=protected)
        if args.apply:
            for segment in candidates:
                target = "removed_ids" if remove_if_unchanged(segment, uid, args.min_age) else "skipped_ids"
                report[target].append(segment.id)
        after = inspect()
        report.update(after_count=len(after), removed_count=len(report["removed_ids"]),
                      skipped_count=len(report["skipped_ids"]))
        # Other processes can legitimately create/destroy their own segments;
        # never "repair" a difference by broadening this cleanup's selection.
        print(json.dumps({k: v for k, v in report.items() if not k.endswith("_ids")}, indent=2))
    except Exception as error:
        report["error"] = type(error).__name__
        print("Cleanup stopped; no further segments will be touched. Error type: " + type(error).__name__, file=sys.stderr)
        return 1
    finally:
        if report_fd is not None:
            with os.fdopen(report_fd, "w") as output:
                json.dump(report, output, indent=2)
                output.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
