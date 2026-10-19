"""Qualification-only owner-scoped fixed-mode Mutter monitor provider.

A standalone ScreenCast session owns only its RecordVirtual stream. No RFB,
GStreamer/PipeWire consumer, pixels, RemoteDesktop session, clipboard or keyboard
is created here. The monitor can outlive a separately fenced human share.
"""
import os
import socket
import struct

from gi.repository import Gio, GLib
from gnome_wayland_native import RD, SC, DBUS, pump_until


class MonitorProvider:
    def __init__(self, compositor_pid, runtime, width=1280, height=800):
        assert 64 <= width <= 4096 and 64 <= height <= 2160
        self.bus = Gio.DBusConnection.new_for_address_sync(
            os.environ["DBUS_SESSION_BUS_ADDRESS"],
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
            Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
        owners = []
        for name in (RD, SC, "org.gnome.Mutter.DisplayConfig"):
            owner = self.call(DBUS, "/org/freedesktop/DBus", DBUS, "GetNameOwner", "(s)", (name,))[0]
            assert self.call(DBUS, "/org/freedesktop/DBus", DBUS, "GetConnectionUnixProcessID", "(s)", (owner,))[0] == compositor_pid
            assert self.call(DBUS, "/org/freedesktop/DBus", DBUS, "GetConnectionUnixUser", "(s)", (owner,))[0] == os.getuid()
            owners.append(owner)
        assert len(set(owners)) == 1
        self.owner = owners[0]
        with socket.socket(socket.AF_UNIX) as peer:
            peer.connect(os.path.join(runtime, os.environ["WAYLAND_DISPLAY"]))
            pid, uid, _gid = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            assert pid == compositor_pid and uid == os.getuid()
        state = self.layout()
        assert not state[1] and not state[2]  # Never supplement somebody else's display.
        self.session = self.call(self.owner, "/org/gnome/Mutter/ScreenCast", SC,
                                 "CreateSession", "(a{sv})", ({},))[0]
        self.stream = self.call(self.owner, self.session, SC + ".Session", "RecordVirtual",
                                "(a{sv})", ({
                                    "cursor-mode": GLib.Variant("u", 0),
                                    "modes": GLib.Variant("aa{sv}", [{
                                        "size": GLib.Variant("(uu)", (width, height)),
                                        "refresh-rate": GLib.Variant("d", 60.0),
                                        "is-preferred": GLib.Variant("b", True),
                                    }]),
                                },))[0]
        self.call(self.owner, self.session, SC + ".Session", "Start")
        pump_until(lambda: len(self.layout()[1]) == len(self.layout()[2]) == 1)
        state = self.layout()
        self.monitor_spec = state[1][0][0]
        self.logical = state[2][0]
        active = [mode for mode in state[1][0][1] if mode[6].get("is-current")]
        assert len(active) == 1 and active[0][1:3] == (width, height)
        assert self.logical[:4] == (0, 0, 1.0, 0)

    def call(self, destination, path, interface, method, signature=None, args=()):
        return self.bus.call_sync(destination, path, interface, method,
                                  GLib.Variant(signature, args) if signature else None,
                                  None, Gio.DBusCallFlags.NO_AUTO_START, 3000, None).unpack()

    def layout(self):
        return self.call(self.owner, "/org/gnome/Mutter/DisplayConfig",
                         "org.gnome.Mutter.DisplayConfig", "GetCurrentState")

    def stop(self):
        # This caller owns precisely this session. No physical display
        # reconfiguration, saved/reused PID signalling or monitor guessing.
        self.call(self.owner, self.session, SC + ".Session", "Stop")
        pump_until(lambda: all(monitor[0] != self.monitor_spec for monitor in self.layout()[1]))
        xml = self.call(self.owner, self.session, "org.freedesktop.DBus.Introspectable", "Introspect")[0]
        assert SC + ".Session" not in xml

    def close(self):
        self.bus.close_sync(None)
