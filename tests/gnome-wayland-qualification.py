#!/usr/bin/python3
"""Opt-in native qualification on a NEW isolated GNOME compositor, never the host.

Run: /usr/bin/python3 tests/gnome-wayland-qualification.py
No production code/settings are changed. Reports only synthetic fixture metadata.
A passing test diagnoses missing cleanup proof; it does not qualify handback.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent


def outer():
    with tempfile.TemporaryDirectory(prefix="jelly-gnome-qualification-") as tmp:
        root = Path(tmp)
        for name in ("home", "runtime", "config", "data", "cache"):
            (root / name).mkdir(mode=0o700)
        modes = root / "data/gnome-shell/modes"
        modes.mkdir(parents=True)
        (modes / "jelly-fixture.json").write_text(json.dumps({
            "hasWindows": True, "hasWorkspaces": True, "allowScreencast": True,
            "components": [], "panel": {"left": [], "center": [], "right": ["keyboard"]},
        }))
        # No service directories: D-Bus cannot activate a secret service, portals,
        # user-systemd bridge, or any application from the real user's session.
        config = root / "bus.conf"
        config.write_text(f'''<busconfig><type>session</type>
<listen>unix:path={root}/runtime/bus</listen><auth>EXTERNAL</auth>
<policy context="default"><allow own="*"/><allow send_destination="*"/>
<allow receive_sender="*"/></policy></busconfig>''')
        library = root / "input-delay.so"
        subprocess.run([
            "/usr/bin/gcc", "-shared", "-fPIC", "-Wall", "-Wextra", "-Werror",
            str(HERE / "fixtures/gnome-wayland-input-delay.c"), "-o", str(library),
            *subprocess.check_output(["/usr/bin/pkg-config", "--cflags", "--libs",
                                      "gio-2.0"], text=True).split(), "-ldl",
        ], check=True)
        # Do not inherit any display, bus, PipeWire, secret service, hardware
        # configuration, Xauthority, LD_PRELOAD, or the real HOME from Jelly.
        env = {
            "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
            "HOME": str(root / "home"), "XDG_RUNTIME_DIR": str(root / "runtime"),
            "XDG_CONFIG_HOME": str(root / "config"), "XDG_DATA_HOME": str(root / "data"),
            "XDG_CACHE_HOME": str(root / "cache"), "XDG_SESSION_TYPE": "wayland",
            "XDG_DATA_DIRS": f"{root}/data:/usr/share",
            "DBUS_SYSTEM_BUS_ADDRESS": f"unix:path={root}/no-system-bus",
            "GSETTINGS_BACKEND": "keyfile", "NO_AT_BRIDGE": "1", "GTK_A11Y": "none",
            "LIBGL_ALWAYS_SOFTWARE": "1", "GALLIUM_DRIVER": "llvmpipe",
            "GSK_RENDERER": "cairo", "GDK_BACKEND": "wayland",
            "WAYLAND_DISPLAY": "fixture-wayland", "PIPEWIRE_REMOTE": "pipewire-0",
            "JELLY_GNOME_FIXTURE_ROOT": str(root),
        }
        command = ["/usr/bin/dbus-run-session", f"--config-file={config}", "--",
                   "/usr/bin/python3", str(Path(__file__).resolve()), "--isolated-child"]
        child = subprocess.Popen(command, env=env, start_new_session=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            out, err = child.communicate(timeout=60)
            if child.returncode:
                # Only generated fixture logs, not any host process output.
                print(err[-14000:], file=sys.stderr)
                raise RuntimeError("Isolated GNOME qualification failed")
            print(out.strip())
        finally:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            if child.poll() is None:
                child.wait(timeout=5)


def inner():
    sys.path.insert(0, str(HERE / "fixtures"))
    import gnome_wayland_native as native
    import gnome_wayland_input as evdev
    import gi
    gi.require_version("Gtk", "4.0")
    gi.require_version("Gdk", "4.0")

    root = Path(os.environ["JELLY_GNOME_FIXTURE_ROOT"])
    assert root.name.startswith("jelly-gnome-qualification-")
    assert str(root / "runtime") == os.environ["XDG_RUNTIME_DIR"]
    assert os.environ["HOME"] == str(root / "home")
    assert not os.environ.get("DISPLAY") and not os.environ.get("XAUTHORITY")
    assert os.environ["DBUS_SESSION_BUS_ADDRESS"].split(",")[0] == f"unix:path={root}/runtime/bus"
    # Shell requires a reachable system bus even without logind. Reuse the
    # private activation-free bus; no method can reach the host system bus.
    os.environ["DBUS_SYSTEM_BUS_ADDRESS"] = os.environ["DBUS_SESSION_BUS_ADDRESS"]
    from gnome_wayland_monitor import MonitorProvider
    processes = []
    sessions = []
    monitor_provider = None
    log = open(root / "fixture.log", "w+")

    def spawn(args, extra=None):
        child = subprocess.Popen(args, env={**os.environ, **(extra or {})},
                                 stdout=log, stderr=log)
        processes.append(child)
        return child

    try:
        # Fixture-only configuration in its private keyfile backend. This is NOT
        # helper behavior and never writes the real user's keyboard settings.
        subprocess.run(["/usr/bin/gsettings", "set", "org.gnome.desktop.input-sources",
                        "sources", "[('xkb', 'gb')]"], check=True)
        spawn(["/usr/bin/pipewire"])
        native.pump_until(lambda: (root / "runtime/pipewire-0").exists())
        # The packaged policy-only profile has NO audio/bluetooth/camera hardware
        # monitors. Neither daemon receives the real session/system bus.
        spawn(["/usr/bin/wireplumber", "--profile=policy"])
        gate, blocked = root / "hold-input", root / "input-blocked"
        shell = spawn([
            "/usr/bin/gnome-shell", "--headless", "--no-x11",
            "--wayland-display", "fixture-wayland",
            "--mode=jelly-fixture",
        ], {
            "LD_PRELOAD": str(root / "input-delay.so"),
            "JELLY_FIXTURE_INPUT_GATE": str(gate),
            "JELLY_FIXTURE_INPUT_BLOCKED": str(blocked),
            "JELLY_FIXTURE_INPUT_QUEUED": str(root / "input-queued"),
            "JELLY_FIXTURE_INPUT_COMPLETED": str(root / "input-completed"),
            "JELLY_FIXTURE_QUERY_GATE": str(root / "hold-query"),
            "JELLY_FIXTURE_QUERY_BLOCKED": str(root / "query-blocked"),
            "JELLY_FIXTURE_QUERY_PENDING": str(root / "query-saw-pending-events"),
        })
        native.pump_until(lambda: (root / "runtime/fixture-wayland").exists())
        time.sleep(0.5)  # Startup only, not an input/cleanup fence.
        # Deliberate fixture-owned monitor provisioning from a genuinely empty
        # same-compositor layout; provider has NO consumer or input session.
        monitor_provider = MonitorProvider(shell.pid, str(root / "runtime"), 640, 480)
        from gi.repository import Gdk, Gtk
        Gtk.init()
        window = Gtk.Window(title="Disposable Jelly native input fixture")
        window.set_default_size(640, 480)
        box = Gtk.Box()
        box.set_focusable(True)
        box.add_css_class("fixture")
        window.set_child(box)
        spinner = Gtk.Spinner()
        spinner.set_size_request(32, 32)
        spinner.start()
        box.append(spinner)
        css = Gtk.CssProvider()
        css.load_from_string(".fixture { background-color: rgb(51, 204, 51); }")
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
                                                 Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        events = {"key_down": False, "key_up": False, "button_down": False,
                  "button_up": False, "unmodified_marker": False, "held_marker": False,
                  "mapped_symbol": False}
        key = Gtk.EventControllerKey()

        def key_event(pressed, keyval):
            if keyval == Gdk.KEY_Shift_L:
                events["key_down" if pressed else "key_up"] = True
            if pressed and keyval == Gdk.KEY_A:
                events["mapped_symbol"] = True
            return False

        key.connect("key-pressed", lambda _c, keyval, *_: key_event(True, keyval))
        key.connect("key-released", lambda _c, keyval, *_: key_event(False, keyval))
        key.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        window.add_controller(key)
        click = Gtk.GestureClick()
        click.connect("pressed", lambda *_: events.__setitem__("button_down", True))
        click.connect("released", lambda *_: events.__setitem__("button_up", True))
        box.add_controller(click)
        motion = Gtk.EventControllerMotion()

        def moved(controller, _x, _y):
            state = controller.get_current_event_state()
            held = Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.BUTTON1_MASK
            if not state & held:
                events["unmodified_marker"] = True
            if state & held == held:
                events["held_marker"] = True

        motion.connect("motion", moved)
        box.add_controller(motion)
        window.present()
        window.fullscreen()
        box.grab_focus()
        native.pump_until(lambda: window.get_mapped())
        box.grab_focus()
        session = native.NativeSession(shell.pid, str(root / "runtime"), fixture=True)
        sessions.append(session)
        native.pump_until(lambda: session.fixture_color)
        session.move(200, 200)
        session.move(200, 200)
        native.pump_until(lambda: session.cursor == (200, 200))
        native.pump_until(lambda: Gdk.Display.get_default().get_default_seat().get_pointer() is not None)
        session.move(201, 201)
        native.pump_until(lambda: session.cursor == (201, 201))
        session.button(True)
        native.pump_until(lambda: events["button_down"])
        session.key(30, True)  # Initialize the disposable wl_keyboard capability.
        native.pump_until(lambda: Gdk.Display.get_default().get_default_seat().get_keyboard() is not None)
        session.key(30, False)
        # Let the new wl_keyboard bind before the actual assertion key.
        baseline = session.frames
        native.pump_until(lambda: session.frames > baseline + 2)
        policy = evdev.EvdevInput(session, Gdk.Display.get_default())
        policy.event(Gdk.KEY_Shift_L, True)
        policy.event(Gdk.KEY_A, True)
        native.pump_until(lambda: events["key_down"] and events["mapped_symbol"])
        # Explicit releases followed by a different cursor position are a normal
        # path experiment ONLY. Fresh cursor metadata has no release/device ID.
        baseline = session.frames
        gate.touch(mode=0o600)
        policy.release()
        session.release_tracked()
        session.move(210, 215)
        native.pump_until(blocked.exists)
        # Fresh full buffers are still delivered while actual release/motion
        # dispatch is stalled. Neither fresh timestamps nor D-Bus ACKs suffice.
        native.pump_until(lambda: session.frames > baseline + 3)
        assert session.cursor != (210, 215)
        assert not events["key_up"] and not events["button_up"]
        gate.unlink()
        native.pump_until(lambda: events["key_up"] and events["button_up"])
        native.pump_until(lambda: session.frames > baseline and session.cursor == (210, 215))
        normal_marker = events["key_up"] and events["button_up"]
        policy.close()
        # Now hold real native input dispatch while allowing the main D-Bus
        # context to acknowledge releases AND destroy the compositor session.
        session.key(42, True)
        session.button(True)
        # Move with held inputs, wait for BOTH fixture seat-state and cursor
        # evidence before blocking actual input dispatch.
        events["held_marker"] = False
        session.move(220, 225)
        native.pump_until(lambda: events["held_marker"] and session.cursor == (220, 225))
        events["key_up"] = events["button_up"] = False
        blocked.unlink()
        gate.touch(mode=0o600)
        session.release_tracked()
        native.pump_until(blocked.exists)
        session.stop()
        assert blocked.exists() and gate.exists()
        assert not events["key_up"] and not events["button_up"]
        # This is the concrete safety regression: Stop ACK + Closed + removed
        # object can ALL precede actual keyboard/pointer releases.
        gate.unlink()
        native.pump_until(lambda: events["key_up"] and events["button_up"])
        # A second session may demonstrate eventual normal operation, but its
        # cursor cannot certify releases from an old device with queued refs.
        fresh = native.NativeSession(shell.pid, str(root / "runtime"), fixture=True)
        sessions.append(fresh)
        fresh.move(230, 235)
        fresh.move(230, 235)
        native.pump_until(lambda: fresh.cursor == (230, 235))
        fresh.move(232, 237)
        native.pump_until(lambda: fresh.cursor == (232, 237))
        events["button_down"] = False
        fresh.button(True)
        native.pump_until(lambda: events["button_down"])
        fresh.key(30, True)
        fresh.key(30, False)
        baseline = fresh.frames
        native.pump_until(lambda: fresh.frames > baseline + 2)
        changed_policy = evdev.EvdevInput(fresh, Gdk.Display.get_default())
        events["held_marker"] = False
        changed_policy.event(Gdk.KEY_A, True)
        fresh.move(231, 236)
        native.pump_until(lambda: events["held_marker"])
        events["key_up"] = False
        # Actual compositor mapping change via ONLY this fixture's keyfile.
        subprocess.run(["/usr/bin/gsettings", "set", "org.gnome.desktop.input-sources",
                        "sources", "[('xkb', 'us')]"], check=True)
        native.pump_until(lambda: changed_policy.revoked)
        native.pump_until(lambda: fresh.property(fresh.rd, native.RD + ".Session", "CurrentKeymap").get("name") == "English (US)")
        calls = fresh.input_calls
        try:
            changed_policy.event(Gdk.KEY_Return, True)
        except evdev.InputUnavailable:
            pass
        else:
            raise AssertionError("Layout change did not block submission")
        assert fresh.input_calls == calls
        events["unmodified_marker"] = False
        changed_policy.release()  # Exact original EVDEV codes, not current symbols.
        fresh.release_tracked()
        fresh.move(240, 245)
        native.pump_until(lambda: events["unmodified_marker"] and fresh.cursor == (240, 245))
        assert not fresh.keys and not changed_policy.counts
        changed_policy.close()
        subprocess.run(["/usr/bin/gsettings", "set", "org.gnome.desktop.input-sources",
                        "sources", "[('xkb', 'gb')]"], check=True)
        native.pump_until(lambda: fresh.property(fresh.rd, native.RD + ".Session", "CurrentKeymap").get("name") == "English (UK)")
        native.pump_until(lambda: Gdk.Display.get_default().translate_key(48, Gdk.ModifierType.SHIFT_MASK, 0)[1] == Gdk.KEY_at)
        unsupported = evdev.EvdevInput(fresh, Gdk.Display.get_default())
        calls = fresh.input_calls
        for symbol in (0x0101f600, Gdk.KEY_Return):
            try:
                unsupported.event(symbol, True)
            except evdev.InputUnavailable:
                pass
            else:
                raise AssertionError("Unsupported input did not stop subsequent submission")
        assert fresh.input_calls == calls
        unsupported.close()
        a11y_policy = evdev.EvdevInput(fresh, Gdk.Display.get_default())
        subprocess.run(["/usr/bin/gsettings", "set", "org.gnome.desktop.a11y.keyboard",
                        "slowkeys-enable", "true"], check=True)
        native.pump_until(lambda: a11y_policy.revoked)
        try:
            a11y_policy.event(Gdk.KEY_Return, True)
        except evdev.InputUnavailable:
            pass
        else:
            raise AssertionError("Deferred accessibility transform did not block submission")
        assert fresh.input_calls == calls
        a11y_policy.close()
        subprocess.run(["/usr/bin/gsettings", "set", "org.gnome.desktop.a11y.keyboard",
                        "slowkeys-enable", "false"], check=True)
        native.pump_until(lambda: not a11y_policy.a11y.get_boolean("slowkeys-enable"))
        event_policy = evdev.EvdevInput(fresh, Gdk.Display.get_default())
        fresh.move(250, 255)
        native.pump_until(lambda: fresh.cursor == (250, 255))
        event_policy.event(Gdk.KEY_A, True)
        fresh.button(True)
        events["held_marker"] = False
        fresh.move(251, 256)
        native.pump_until(lambda: events["held_marker"] and fresh.cursor == (251, 256))
        events["key_up"] = events["button_up"] = False
        gate.touch(mode=0o600)
        event_policy.release()
        fresh.release_tracked()
        marker1 = fresh.marker_point()
        fresh.move(*marker1)
        queued = int((root / "input-queued").read_text())
        baseline = fresh.sequence
        spinner.stop()  # Qualify a STATIC desktop, not animation-dependent cleanup.
        query_gate = root / "hold-query"
        query_gate.touch(mode=0o600)
        fresh.refresh_full_frame()
        native.pump_until(lambda: (root / "query-blocked").exists())
        # Main thread is inside a real already-selected DEFAULT_IDLE cursor
        # query. All notifications were admitted BEFORE it was paused. Let the
        # original native thread finish releases/motion while main stays there.
        gate.unlink()

        def counter_at_least(path, value):
            try:
                return int(path.read_text()) >= value
            except (ValueError, FileNotFoundError):
                return False

        native.pump_until(lambda: counter_at_least(root / "input-completed", queued))
        assert not events["key_up"] and not events["button_up"]
        query_gate.unlink()
        native.pump_until(lambda: (root / "query-saw-pending-events").exists())
        assert (root / "query-saw-pending-events").read_text() == "1"
        native.pump_until(lambda: fresh.frame_record is not None and fresh.frame_record[0] > baseline and fresh.frame_record[1] == marker1)
        # The FIRST marker can be sampled with native events still queued.
        # A SECOND distinct marker is requested only after the first full buffer
        # arrived. This exercises the candidate, but DEFAULT backend consumption
        # does NOT establish Clutter stage-queue/consumer delivery. Nor have we
        # proven the refreshed consumer's buffer comes from a NEW stage paint.
        first_sequence = fresh.sequence
        marker2 = fresh.marker_point()
        assert marker2 != marker1
        fresh.move(*marker2)
        fresh.refresh_full_frame()
        native.pump_until(lambda: fresh.frame_record is not None and fresh.frame_record[0] > first_sequence and fresh.frame_record[1] == marker2)
        native.pump_until(lambda: events["key_up"] and events["button_up"])
        assert not event_policy.counts and not fresh.keys and not fresh.buttons
        fresh.stop()
        event_policy.close()
        # Human RD/capture objects are gone, but the standalone provider retains
        # its monitor with no PipeWire consumer or virtual input device.
        assert len(monitor_provider.layout()[1]) == len(monitor_provider.layout()[2]) == 1
        window.destroy()
        monitor_provider.stop()
        assert not monitor_provider.layout()[1] and not monitor_provider.layout()[2]
        monitor_provider.close()
        monitor_provider = None
        print(json.dumps({
            "zero_monitor_owner_scoped_virtual_provider": True,
            "monitor_retained_after_human_stream_input_teardown": True,
            "only_owned_monitor_removed_on_provider_teardown": True,
            "fixture": "isolated GNOME 50.1 / private D-Bus / private PipeWire",
            "capture": "synthetic 640x480 BGRx in memory only",
            "native_keyboard_pointer": True,
            "normal_explicit_release_cursor_marker_observed": normal_marker,
            "normal_marker_withheld_during_actual_input_delay": True,
            "fixed_gb_evdev_mapping_verified_against_compositor": True,
            "mapping_change_releases_original_evdev_codes": True,
            "mapping_a11y_unsupported_symbol_block_subsequent_enter": True,
            "actual_input_dispatch_delayed": True,
            "stop_closed_removed_before_input_release": True,
            "eventual_fixture_key_button_release_observed": True,
            "first_idle_marker_can_sample_pending_compositor_events": True,
            "two_full_frame_markers_and_eventual_fixture_releases_observed": True,
            "second_frame_proves_stage_consumer_drain": False,
            "static_desktop_same_stream_full_frame_refresh": True,
            "production_cleanup_qualified": False,
            "blocker": "Unproven Clutter stage-consumer drain and same-stream refresh buffer freshness; production Wayland entry remains absent",
        }, sort_keys=True))
    finally:
        (root / "hold-input").unlink(missing_ok=True)
        (root / "hold-query").unlink(missing_ok=True)
        for session in sessions:
            try:
                session.close()
            except Exception:
                pass
        if monitor_provider:
            monitor_provider.close()
        for child in reversed(processes):
            if child.poll() is None:
                child.terminate()
        for child in reversed(processes):
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        log.seek(0)
        if sys.exc_info()[0]:
            if "events" in locals():
                print("fixture events", events, "size", window.get_width(), window.get_height(), "frames", session.frames if "session" in locals() else 0, "cursor", session.cursor if "session" in locals() else None, file=sys.stderr)
            print(log.read()[-6000:], file=sys.stderr)
        log.close()


if __name__ == "__main__":
    if sys.argv[1:] == ["--isolated-child"]:
        inner()
    elif not sys.argv[1:]:
        outer()
    else:
        raise SystemExit("No display/bus/input arguments are accepted")
