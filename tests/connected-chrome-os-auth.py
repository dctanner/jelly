#!/usr/bin/python3
"""Disposable OS-auth qualification. Never connects to the owner's session bus."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent


def inner():
    import gi
    gi.require_version("Secret", "1")
    from gi.repository import Gio, GLib, Secret
    spec = importlib.util.spec_from_file_location("auth", HERE.parent / "scripts/connected-chrome-os-auth.py")
    auth = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(auth)
    root = Path(os.environ["FIXTURE_ROOT"])
    assert root.name.startswith("jelly-os-auth-") and os.environ["HOME"] == str(root / "home")
    assert os.environ["DBUS_SESSION_BUS_ADDRESS"].split(",")[0] == f"unix:path={root}/runtime/bus"
    control = root / "control"
    control.mkdir(mode=0o700)
    daemon = subprocess.Popen(["/usr/bin/gnome-keyring-daemon", "--foreground", "--login", "--components=secrets",
                               f"--control-directory={control}"], stdin=subprocess.PIPE,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    daemon.stdin.write(b"disposable-fixture-passphrase")
    daemon.stdin.close()
    try:
        for _ in range(100):
            if (control / "control").exists():
                break
            time.sleep(.02)
        subprocess.run(["/usr/bin/gnome-keyring-daemon", "--start", "--components=secrets", f"--control-directory={control}"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=3)
        bus = auth.connection(os.environ["DBUS_SESSION_BUS_ADDRESS"])
        # Initialization only: the private fixture creates a synthetic item so
        # the PAM-created login collection is materialized on disk. No host data.
        schema = Secret.Schema.new("org.jelly.Disposable", Secret.SchemaFlags.NONE,
                                   {"fixture": Secret.SchemaAttributeType.STRING})
        assert Secret.password_store_sync(schema, {"fixture": "test"}, Secret.COLLECTION_DEFAULT,
                                          "Synthetic fixture", "fixture-value", None)
        binding, locked = auth.snapshot(str(control / "control"), os.environ["DBUS_SESSION_BUS_ADDRESS"])
        assert binding["pid"] == daemon.pid and not locked
        # Lock the EXACT canonical login collection, not an inferred default.
        auth.call(bus, binding["owner"], "/org/freedesktop/secrets", "org.freedesktop.Secret.Service", "Lock", "(ao)", ([auth.COLLECTION],))
        assert auth.snapshot(binding["control"], binding["bus"])[1]
        assert auth.unlock(binding, b"wrong-disposable-passphrase") is False
        assert auth.snapshot(binding["control"], binding["bus"])[1]
        assert auth.unlock(binding, b"disposable-fixture-passphrase") is True
        assert not auth.snapshot(binding["control"], binding["bus"])[1]
        for change in ({"start": "0"}, {"pid": os.getpid()}, {"owner": ":9999.9999"}, {"socket": [0, 0, 0]}, {"bus": f"unix:path={root}/absent"}):
            try:
                auth.unlock({**binding, **change}, b"disposable-fixture-passphrase")
            except Exception:
                pass
            else:
                raise AssertionError("Changed daemon/socket/bus binding admitted")
        if os.environ.get("JELLY_AUTH_PICKER_FIXTURE") == "1":
            # Synthetic original-session portal owner; must remain invisible to
            # Chrome while the same connection still exposes Secret Service.
            auth.call(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName", "(su)", ("org.freedesktop.portal.Desktop", 0))
            child = subprocess.run(["/usr/local/bin/bun", str(HERE / "owned-chrome-file-picker.ts")],
                                   env=os.environ, timeout=120)
            assert child.returncode == 0
            items = Secret.Service.get_sync(Secret.ServiceFlags.LOAD_COLLECTIONS, None).search_sync(
                Secret.Schema.new("org.freedesktop.Secret.Generic", Secret.SchemaFlags.DONT_MATCH_NAME,
                                  {"application": Secret.SchemaAttributeType.STRING}),
                {"application": "chrome"}, Secret.SearchFlags.ALL, None)
            assert items, "Stable Chrome must use the real private fixture Secret Service"
            auth.call(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ReleaseName", "(s)", ("org.freedesktop.portal.Desktop",))
            print("PASS stable Chrome synthetic Safe Storage item exists in original private keyring through filtered bus")
        if os.environ.get("JELLY_AUTH_BROWSER_FIXTURE") == "1":
            auth.call(bus, binding["owner"], "/org/freedesktop/secrets", "org.freedesktop.Secret.Service", "Lock", "(ao)", ([auth.COLLECTION],))
            child = subprocess.run(["/usr/local/bin/bun", str(HERE / "owned-chrome-desktop.browser.ts")],
                                   env={**os.environ, "FIXTURE_CONTROL": str(control / "control")}, timeout=150)
            assert child.returncode == 0
        if daemon.poll() is None:
            daemon.terminate()
            daemon.wait(timeout=3)
        try:
            auth.unlock(binding, b"disposable-fixture-passphrase")
        except Exception:
            pass
        else:
            raise AssertionError("Dead daemon admitted")
        daemon = subprocess.Popen(["/usr/bin/gnome-keyring-daemon", "--foreground", "--components=secrets",
                                   f"--control-directory={control}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        replacement = None
        for _ in range(100):
            try:
                replacement, _ = auth.snapshot(binding["control"], binding["bus"])
                if replacement["pid"] == daemon.pid:
                    break
            except Exception:
                pass
            time.sleep(.02)
        assert replacement and replacement["pid"] == daemon.pid and replacement["owner"] != binding["owner"]
        try:
            auth.unlock(binding, b"disposable-fixture-passphrase")
        except Exception:
            pass
        else:
            raise AssertionError("Replacement daemon admitted with old binding")
        daemon.terminate(); daemon.wait(timeout=3)
        inherited_spec = importlib.util.spec_from_file_location('inherited', HERE / 'fixtures/owned-keyring-systemd.py')
        inherited = importlib.util.module_from_spec(inherited_spec); inherited_spec.loader.exec_module(inherited)
        inherited_results = inherited.qualify(auth, bus, root)
        print(json.dumps({**inherited_results, "private_daemon_bus_control_pid_verified": True,
                          "restarted_private_daemon_old_binding_refused": True,
                          "wrong_password_same_login_collection_stays_locked": True,
                          "correct_password_unlocks_same_login_collection": True,
                          "changed_dead_daemon_socket_bus_binding_refused": True}))
    finally:
        if daemon.poll() is None:
            daemon.terminate()
            daemon.wait(timeout=3)


def outer():
    with tempfile.TemporaryDirectory(prefix="jelly-os-auth-") as tmp:
        root = Path(tmp)
        for name in ("home", "runtime", "config", "data", "cache"):
            (root / name).mkdir(mode=0o700)
        config = root / "bus.conf"
        config.write_text(f'''<busconfig><type>session</type><listen>unix:path={root}/runtime/bus</listen><auth>EXTERNAL</auth>
<policy context="default"><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>''')
        env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(root / "home"),
               "JELLY_AUTH_BROWSER_FIXTURE": os.environ.get("JELLY_AUTH_BROWSER_FIXTURE", "0"),
               "JELLY_AUTH_PICKER_FIXTURE": os.environ.get("JELLY_AUTH_PICKER_FIXTURE", "0"),
               "JELLY_FIXTURE_BROWSER": os.environ.get("JELLY_FIXTURE_BROWSER", ""),
               **{key: os.environ[key] for key in ("JELLY_FIXTURE_OPENBOX", "JELLY_FIXTURE_WM_LIBRARY", "JELLY_FIXTURE_WM_DATA") if key in os.environ},
               "XDG_RUNTIME_DIR": str(root / "runtime"), "XDG_CONFIG_HOME": str(root / "config"),
               "XDG_DATA_HOME": str(root / "data"), "XDG_CACHE_HOME": str(root / "cache"),
               "DBUS_SYSTEM_BUS_ADDRESS": f"unix:path={root}/absent-system", "FIXTURE_ROOT": str(root)}
        child = subprocess.Popen(["/usr/bin/dbus-run-session", f"--config-file={config}", "--", "/usr/bin/python3", str(Path(__file__).resolve()), "--child"],
                                 env=env, start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            out, err = child.communicate(timeout=180 if env["JELLY_AUTH_BROWSER_FIXTURE"] == "1" or env["JELLY_AUTH_PICKER_FIXTURE"] == "1" else 30)
            if child.returncode:
                print(err[-4000:], file=sys.stderr)
                raise RuntimeError("Private authentication fixture failed")
            print(out.strip())
        finally:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            if child.poll() is None:
                child.wait(timeout=3)


if __name__ == "__main__":
    if sys.argv[1:] == ["--child"]:
        inner()
    elif not sys.argv[1:]:
        outer()
    else:
        raise SystemExit(1)
