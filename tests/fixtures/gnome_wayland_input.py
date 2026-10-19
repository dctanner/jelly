"""Qualification-only fixed GB EVDEV input, never keysym emulation.

No text history: only the currently held RFB identities/codes and modifier
references exist transiently, solely to release the exact admitted native codes.
Unsupported/config-changed input permanently rejects subsequent keys, including
Return. This helper NEVER changes the keyboard/a11y configuration.
"""
import gi

gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, Gio

# Default pc105 English (UK), no variants/options/IME. Compare the compositor's
# actual Wayland keymap, not only the display name or desired GSettings value.
GB_LEVELS = {
    2: "1!", 3: '2"', 4: "3£", 5: "4$", 6: "5%", 7: "6^", 8: "7&",
    9: "8*", 10: "9(", 11: "0)", 12: "-_", 13: "=+",
    16: "qQ", 17: "wW", 18: "eE", 19: "rR", 20: "tT", 21: "yY",
    22: "uU", 23: "iI", 24: "oO", 25: "pP", 26: "[{", 27: "]}",
    30: "aA", 31: "sS", 32: "dD", 33: "fF", 34: "gG", 35: "hH",
    36: "jJ", 37: "kK", 38: "lL", 39: ";:", 40: "'@", 41: "`¬", 43: "#~",
    44: "zZ", 45: "xX", 46: "cC", 47: "vV", 48: "bB", 49: "nN",
    50: "mM", 51: ",<", 52: ".>", 53: "/?", 57: "  ", 86: "\\|",
}
SPECIAL = {
    0xff1b: 1, 0xff08: 14, 0xff09: 15, 0xff0d: 28,
    0xffe1: 42, 0xffe2: 54, 0xffe3: 29, 0xffe4: 97, 0xffe9: 56,
    0xff50: 102, 0xff52: 103, 0xff55: 104, 0xff51: 105,
    0xff53: 106, 0xff57: 107, 0xff54: 108, 0xff56: 109,
    0xff63: 110, 0xffff: 111,
}
A11Y_FLAGS = ("enable", "stickykeys-enable", "slowkeys-enable",
              "bouncekeys-enable", "mousekeys-enable", "togglekeys-enable")


class InputUnavailable(Exception):
    def __init__(self):
        # Never include the rejected symbol, keys, or raw native error.
        super().__init__("Unsupported or changed keyboard configuration; input stopped. Return/submission is blocked.")


def check_settings(sources, a11y):
    assert sources.get_value("sources").unpack() == [("xkb", "gb")]
    assert not sources.get_strv("xkb-options")
    assert sources.get_string("xkb-model") == "pc105+inet"
    assert not sources.get_boolean("per-window")
    assert not any(a11y.get_boolean(name) for name in A11Y_FLAGS)


class EvdevInput:
    def __init__(self, session, display):
        self.session = session
        self.display = display
        self.sources = Gio.Settings.new("org.gnome.desktop.input-sources")
        self.a11y = Gio.Settings.new("org.gnome.desktop.a11y.keyboard")
        self.revoked = False
        self.configuration_changed = False
        self.held = {}  # Only outstanding RFB-down identities; never history.
        self.counts = {}  # Native EVDEV code -> active physical/synthetic refs.
        self.connections = [
            (self.sources, self.sources.connect("changed", self.changed)),
            (self.a11y, self.a11y.connect("changed", self.changed)),
        ]
        self.keymap_subscription = session.bus.signal_subscribe(
            session.owner, "org.freedesktop.DBus.Properties", "PropertiesChanged",
            session.rd, "org.gnome.Mutter.RemoteDesktop.Session", Gio.DBusSignalFlags.NONE,
            self.native_changed) if session else None
        self.mapping = dict(SPECIAL)
        for code, levels in GB_LEVELS.items():
            for shifted, symbol in enumerate(levels):
                self.mapping.setdefault(ord(symbol), (code, bool(shifted)))
        try:
            self.check()
        except Exception:
            self.close()
            raise

    def changed(self, *_args):
        # A change back to a supported value does not resurrect admission.
        self.revoked = True
        self.configuration_changed = True

    def native_changed(self, _bus, _sender, _path, _iface, _name, args):
        _interface, changed, invalidated = args.unpack()
        if "CurrentKeymap" in changed or "CurrentKeymap" in invalidated:
            self.revoked = True
            self.configuration_changed = True

    def check(self, releasing=False):
        try:
            assert not self.configuration_changed
            assert releasing or not self.revoked
            check_settings(self.sources, self.a11y)
            if self.session:
                assert not self.session.property(self.session.rd,
                                                 "org.gnome.Mutter.RemoteDesktop.Session", "CapsLockState")
                current = self.session.property(self.session.rd,
                                                 "org.gnome.Mutter.RemoteDesktop.Session", "CurrentKeymap")
                assert current == {"name": "English (UK)", "source": 0}
            # This GDK display has an authoritative wl_keyboard.keymap from the
            # bound compositor. Layout names alone are not an attestation.
            for code, levels in GB_LEVELS.items():
                for shifted, symbol in enumerate(levels):
                    ok, actual, group, level, _consumed = self.display.translate_key(
                        code + 8, Gdk.ModifierType.SHIFT_MASK if shifted else Gdk.ModifierType(0), 0)
                    assert ok and group == 0 and actual == ord(symbol)
            for symbol, code in SPECIAL.items():
                ok, actual, group, _level, _consumed = self.display.translate_key(
                    code + 8, Gdk.ModifierType(0), 0)
                assert ok and group == 0 and actual == symbol
        except Exception:
            self.revoked = True
            raise InputUnavailable() from None

    def native(self, code, pressed):
        count = self.counts.get(code, 0)
        if pressed:
            self.counts[code] = count + 1  # Obligation precedes even an uncertain send.
            if count == 0:
                self.session.key(code, True)
        elif count:
            if count == 1:
                self.session.key(code, False)
                del self.counts[code]
            else:
                self.counts[code] = count - 1

    def event(self, symbol, pressed):
        self.check()
        if not isinstance(symbol, int) or type(pressed) is not bool or symbol not in self.mapping:
            self.revoked = True
            raise InputUnavailable()
        if pressed:
            if symbol in self.held:
                return  # EVDEV repeat is compositor-owned; never duplicate downs.
            value = self.mapping[symbol]
            code, shift = value if isinstance(value, tuple) else (value, False)
            codes = (42, code) if shift else (code,)
            # Record obligation BEFORE sending any native down.
            self.held[symbol] = codes
            for item in codes:
                self.native(item, True)
        elif symbol in self.held:
            for code in reversed(self.held.pop(symbol)):
                self.native(code, False)

    def release(self):
        # Cleanup deliberately ignores changed mapping: release exactly the
        # admitted EVDEV codes, without re-resolving keysyms or adding modifiers.
        self.revoked = True
        self.held.clear()
        for code in list(self.counts):
            self.session.key(code, False)
            del self.counts[code]

    def close(self):
        if self.keymap_subscription is not None:
            self.session.bus.signal_unsubscribe(self.keymap_subscription)
        for obj, handler in self.connections:
            obj.disconnect(handler)
