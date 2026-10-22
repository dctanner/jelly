#!/usr/bin/python3
"""Disposable subprocess-only parent-death tests. Never signals host services."""
import ctypes
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time

shim = str(pathlib.Path(__file__).parents[1] / "scripts/desktop-child.py")
python = "/usr/bin/python3"
# Adopt/reap only this fixture's descendants after their disposable parents exit.
assert ctypes.CDLL(None).prctl(36, 1) == 0  # PR_SET_CHILD_SUBREAPER
with tempfile.TemporaryDirectory(prefix="jelly-clipboard-parent-") as directory:
    marker = str(pathlib.Path(directory) / "executed")
    action = "import pathlib,time;pathlib.Path(%r).write_text('ready');time.sleep(60)" % marker
    dead = subprocess.Popen(["/usr/bin/true"])
    dead.wait()
    for expected in (1, dead.pid):
        result = subprocess.run([python, shim, "--expected-parent", str(expected), python, "-c", action],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
        assert result.returncode != 0 and not pathlib.Path(marker).exists()
        assert result.stdout == b"" and result.stderr == b""

    for delayed in (True, False):
        script = """
import os,signal,sys
parent = os.getpid()
child = os.fork()
if child == 0:
    if %r:
        os.kill(os.getpid(), signal.SIGSTOP)
    os.execv(%r, [%r, %r, '--expected-parent', str(parent), %r, '-c', %r])
print(child, flush=True)
signal.pause()
""" % (delayed, python, python, shim, python, action)
        parent = subprocess.Popen([python, "-c", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        child = int(parent.stdout.readline())
        reaped = False
        try:
            deadline = time.monotonic() + 3
            while True:
                ready = (pathlib.Path('/proc/%d/stat' % child).read_text().split(') ')[1].startswith('T')
                         if delayed else pathlib.Path(marker).exists())
                if ready:
                    break
                assert time.monotonic() < deadline
                time.sleep(.01)
            parent.kill()
            parent.wait(timeout=3)
            if delayed:
                os.kill(child, signal.SIGCONT)  # The shim starts only AFTER original parent death.
            while True:
                pid, status = os.waitpid(child, os.WNOHANG)
                if pid:
                    reaped = True
                    break
                assert time.monotonic() < deadline
                time.sleep(.01)
            if delayed:
                assert os.WIFEXITED(status) and os.WEXITSTATUS(status) != 0
                assert not pathlib.Path(marker).exists()
            else:
                assert os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGKILL
                pathlib.Path(marker).unlink()
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait()
            if not reaped:
                try:
                    os.kill(child, signal.SIGKILL)
                    os.waitpid(child, 0)
                except ProcessLookupError:
                    pass
                except ChildProcessError:
                    pass
print("PASS: wrong/dead expected parent, parent dead before shim initialization, running helper SIGKILL teardown; descendants reaped.")
