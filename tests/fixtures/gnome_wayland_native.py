"""Qualification-only Mutter 50.1 primitives, NOT a production backend.

Only the disposable-compositor fixture imports this module. No RFB/API/model
entry point, clipboard, arbitrary evaluation, pixel output or host targeting.
D-Bus completion/session removal deliberately DO NOT certify input cleanup.
"""
import os
import socket
import struct
import time

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstVideo", "1.0")
from gi.repository import Gio, GLib, Gst, GstVideo

RD = "org.gnome.Mutter.RemoteDesktop"
SC = "org.gnome.Mutter.ScreenCast"
DBUS = "org.freedesktop.DBus"


def pump_until(predicate, timeout=10):
    end = time.monotonic() + timeout
    context = GLib.MainContext.default()
    while not predicate():
        if time.monotonic() >= end:
            raise RuntimeError("Disposable GNOME fixture timed out")
        while context.pending():
            context.iteration(False)
        time.sleep(0.002)


class NativeSession:
    def __init__(self, compositor_pid, runtime, width=640, height=480, fixture=False):
        self.width, self.height, self.fixture = width, height, fixture
        assert 1 <= width <= 4096 and 1 <= height <= 2160
        # Never use inherited default display/bus lookup. This bus was created by
        # the fixture with service activation disabled and an empty environment.
        self.bus = Gio.DBusConnection.new_for_address_sync(
            os.environ["DBUS_SESSION_BUS_ADDRESS"],
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT
            | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            None, None,
        )
        owners = []
        for name in (RD, SC):
            owner = self.call(DBUS, "/org/freedesktop/DBus", DBUS,
                              "GetNameOwner", "(s)", (name,))[0]
            pid = self.call(DBUS, "/org/freedesktop/DBus", DBUS,
                            "GetConnectionUnixProcessID", "(s)", (owner,))[0]
            uid = self.call(DBUS, "/org/freedesktop/DBus", DBUS,
                            "GetConnectionUnixUser", "(s)", (owner,))[0]
            assert pid == compositor_pid and uid == os.getuid()
            owners.append(owner)
        assert owners[0] == owners[1]
        self.owner = owners[0]
        # The only target is the fixture's newly spawned headless compositor.
        path = os.path.join(runtime, os.environ["WAYLAND_DISPLAY"])
        with socket.socket(socket.AF_UNIX) as peer:
            peer.connect(path)
            pid, uid, _ = struct.unpack("3i", peer.getsockopt(
                socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            assert pid == compositor_pid and uid == os.getuid()
        self.rd = self.call(self.owner, "/org/gnome/Mutter/RemoteDesktop", RD,
                            "CreateSession")[0]
        session_id = self.property(self.rd, RD + ".Session", "SessionId")
        self.sc = self.call(self.owner, "/org/gnome/Mutter/ScreenCast", SC,
                            "CreateSession", "(a{sv})", ({
                                "remote-desktop-session-id": GLib.Variant("s", session_id),
                            },))[0]
        self.stream = self.call(self.owner, self.sc, SC + ".Session", "RecordArea",
                                "(iiiia{sv})", (0, 0, width, height, {
                                    "cursor-mode": GLib.Variant("u", 2),
                                }))[0]
        self.node = None
        self.closed = False
        self.subscriptions = [
            self.bus.signal_subscribe(self.owner, SC + ".Stream", "PipeWireStreamAdded",
                                      self.stream, None, Gio.DBusSignalFlags.NONE,
                                      self.stream_added),
            self.bus.signal_subscribe(self.owner, RD + ".Session", "Closed", self.rd,
                                      None, Gio.DBusSignalFlags.NONE, self.session_closed),
            self.bus.signal_subscribe(self.owner, "org.gnome.Mutter.DisplayConfig", "MonitorsChanged",
                                      "/org/gnome/Mutter/DisplayConfig", None,
                                      Gio.DBusSignalFlags.NONE, self.binding_changed),
            self.bus.signal_subscribe(DBUS, DBUS, "NameOwnerChanged", "/org/freedesktop/DBus",
                                      self.owner, Gio.DBusSignalFlags.NONE, self.binding_changed),
        ]
        self.frames = 0
        self.frame_record = None
        self.last_cursor_sample = None
        # Unordered, transient coordinate membership only (<=1.1MB), not an
        # input log. A cleanup marker must NEVER reuse any admitted motion.
        self.motion_targets = bytearray((width * height + 7) // 8)
        self.failed = False
        self.sequence = -1
        self.cursor = None
        self.fixture_color = False
        self.pipeline = None
        self.keys = set()
        self.buttons = set()
        self.input_calls = 0
        self.call(self.owner, self.rd, RD + ".Session", "Start")
        pump_until(lambda: self.node is not None)
        Gst.init(None)
        self.pipeline = Gst.parse_launch(
            f"pipewiresrc path={self.node} always-copy=true ! "
            f"video/x-raw,format=BGRx,width={width},height={height} ! "
            "appsink name=frames emit-signals=true max-buffers=1 drop=true sync=false"
        )
        self.pipeline.get_by_name("frames").connect("new-sample", self.sample)
        self.pipeline.set_state(Gst.State.PLAYING)
        pump_until(lambda: self.frames > 0)

    def call(self, destination, path, interface, method, signature=None, args=()):
        return self.bus.call_sync(
            destination, path, interface, method,
            GLib.Variant(signature, args) if signature else None,
            None, Gio.DBusCallFlags.NO_AUTO_START, 3000, None,
        ).unpack()

    def property(self, path, interface, name):
        return self.call(self.owner, path, "org.freedesktop.DBus.Properties",
                         "Get", "(ss)", (interface, name))[0]

    def stream_added(self, _bus, _sender, _path, _interface, _signal, args):
        self.node = args.unpack()[0]

    def session_closed(self, *_args):
        self.closed = True

    def binding_changed(self, *_args):
        self.failed = True

    def sample(self, sink):
        sample = sink.emit("pull-sample")
        buffer = sample.get_buffer()
        if buffer.get_size() != self.width * self.height * 4:
            self.failed = True
            return Gst.FlowReturn.ERROR
        # Only in-memory boolean validation of the synthetic fixture's color.
        # No images/screenshots/files/base64 or text derived from pixels escape.
        data = buffer.extract_dup(0, buffer.get_size())
        if self.fixture:
            self.fixture_color |= any(data[i:i + 3] == bytes((51, 204, 51))
                                      for i in range(0, len(data) - 3, 4 * 73))
        roi = GstVideo.buffer_get_video_region_of_interest_meta_id(buffer, 0)
        self.cursor = (roi.x, roi.y) if roi else None
        self.sequence = int(buffer.offset)
        self.frame_record = (self.sequence, self.cursor)
        if self.cursor is not None:
            self.last_cursor_sample = self.frame_record
        self.frames += 1
        return Gst.FlowReturn.OK

    def refresh_full_frame(self):
        # Reconnect only the capture consumer to the SAME PipeWire node/stream.
        # Mutter's paused->streaming enable queues a full stage redraw. This
        # does not replace the RD session/input devices or invent monitor state.
        self.pipeline.set_state(Gst.State.NULL)
        result, state, _pending = self.pipeline.get_state(3 * Gst.SECOND)
        assert result == Gst.StateChangeReturn.SUCCESS and state == Gst.State.NULL
        self.pipeline.set_state(Gst.State.PLAYING)

    def key(self, code, pressed):
        assert type(code) is int and 1 <= code <= 127
        self.input_calls += 1
        if pressed:
            self.keys.add(code)
        self.call(self.owner, self.rd, RD + ".Session", "NotifyKeyboardKeycode",
                  "(ub)", (code, pressed))
        (self.keys.add if pressed else self.keys.discard)(code)

    def button(self, pressed, code=272):
        assert code in (272, 273, 274)
        if pressed:
            self.buttons.add(code)
        self.call(self.owner, self.rd, RD + ".Session", "NotifyPointerButton",
                  "(ib)", (code, pressed))
        (self.buttons.add if pressed else self.buttons.discard)(code)

    def marker_point(self):
        assert self.last_cursor_sample is not None
        sampled = self.last_cursor_sample[1]
        area = self.width * self.height
        start = int.from_bytes(os.urandom(4)) % area
        for offset in range(area):
            index = (start + offset) % area
            x, y = index % self.width, index // self.width
            if (0 < x < self.width - 1 and 0 < y < self.height - 1 and
                (x, y) != sampled and not self.motion_targets[index // 8] & (1 << (index % 8))):
                return x, y
        raise RuntimeError("No causally fresh marker coordinate remains")

    def move(self, x, y):
        assert type(x) is int and type(y) is int and 0 <= x < self.width and 0 <= y < self.height
        index = y * self.width + x
        self.motion_targets[index // 8] |= 1 << (index % 8)
        self.call(self.owner, self.rd, RD + ".Session", "NotifyPointerMotionAbsolute",
                  "(sdd)", (self.stream, float(x), float(y)))

    def release_tracked(self):
        for key in list(self.keys):
            self.key(key, False)
        for button in list(self.buttons):
            self.button(False, button)

    def stop(self):
        self.call(self.owner, self.rd, RD + ".Session", "Stop")
        pump_until(lambda: self.closed)
        # Removed interfaces are teardown evidence ONLY, never input drain.
        for path, interface in ((self.rd, RD + ".Session"),
                                (self.sc, SC + ".Session"),
                                (self.stream, SC + ".Stream")):
            try:
                xml = self.call(self.owner, path, "org.freedesktop.DBus.Introspectable", "Introspect")[0]
            except GLib.Error as error:
                name = Gio.DBusError.get_remote_error(error)
                if name not in ("org.freedesktop.DBus.Error.UnknownObject", "org.freedesktop.DBus.Error.UnknownMethod"):
                    raise
            else:
                if len(xml) > 65536 or interface in xml:
                    raise RuntimeError("Compositor session/stream teardown was not confirmed")
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
            self.pipeline = None
        self.frame_record = None

    def close(self):
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
        self.bus.close_sync(None)
