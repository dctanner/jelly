#!/usr/bin/python3
"""One explicit CLIPBOARD/UTF8_STRING conversion; stdout is all-or-nothing UTF-8.

No selection polling or TARGETS inference. A successful empty property is distinct
from SelectionNotify(None). INCR chunks retain type/format and the total size bound.
The caller supplies only its attested DISPLAY/XAUTHORITY and owns process lifetime.
"""
import ctypes as c
import select
import sys
import time

MAX_BYTES = 256 * 1024
Atom = Window = c.c_ulong
Display = c.c_void_p


class SelectionEvent(c.Structure):
    _fields_ = [("type", c.c_int), ("serial", c.c_ulong), ("send_event", c.c_int),
                ("display", Display), ("requestor", Window), ("selection", Atom),
                ("target", Atom), ("property", Atom), ("time", c.c_ulong)]


class PropertyEvent(c.Structure):
    _fields_ = [("type", c.c_int), ("serial", c.c_ulong), ("send_event", c.c_int),
                ("display", Display), ("window", Window), ("atom", Atom),
                ("time", c.c_ulong), ("state", c.c_int)]


class Event(c.Union):
    _fields_ = [("type", c.c_int), ("selection", SelectionEvent),
                ("property", PropertyEvent), ("pad", c.c_long * 24)]


def xlib():
    x = c.CDLL("libX11.so.6")
    signatures = {
        "XOpenDisplay": ([c.c_char_p], Display),
        "XDefaultRootWindow": ([Display], Window),
        "XCreateSimpleWindow": ([Display, Window, c.c_int, c.c_int, c.c_uint, c.c_uint,
                                 c.c_uint, c.c_ulong, c.c_ulong], Window),
        "XInternAtom": ([Display, c.c_char_p, c.c_int], Atom),
        "XSelectInput": ([Display, Window, c.c_long], c.c_int),
        "XConvertSelection": ([Display, Atom, Atom, Atom, Window, c.c_ulong], c.c_int),
        "XPending": ([Display], c.c_int),
        "XNextEvent": ([Display, c.POINTER(Event)], c.c_int),
        "XConnectionNumber": ([Display], c.c_int),
        "XFlush": ([Display], c.c_int),
        "XGetWindowProperty": ([Display, Window, Atom, c.c_long, c.c_long, c.c_int, Atom,
                                c.POINTER(Atom), c.POINTER(c.c_int), c.POINTER(c.c_ulong),
                                c.POINTER(c.c_ulong), c.POINTER(c.c_void_p)], c.c_int),
        "XFree": ([c.c_void_p], c.c_int),
        "XDestroyWindow": ([Display, Window], c.c_int),
        "XCloseDisplay": ([Display], c.c_int),
    }
    for name, (args, result) in signatures.items():
        function = getattr(x, name)
        function.argtypes, function.restype = args, result
    return x


def read_selection():
    x = xlib()
    display = x.XOpenDisplay(None)
    if not display:
        raise ValueError()
    window = 0
    try:
        window = x.XCreateSimpleWindow(display, x.XDefaultRootWindow(display), 0, 0, 1, 1, 0, 0, 0)
        if not window:
            raise ValueError()
        selection = x.XInternAtom(display, b"CLIPBOARD", False)
        target = x.XInternAtom(display, b"UTF8_STRING", False)
        prop = x.XInternAtom(display, b"JELLY_CLIPBOARD_TRANSFER", False)
        incr = x.XInternAtom(display, b"INCR", False)
        x.XSelectInput(display, window, 1 << 22)  # PropertyChangeMask
        x.XConvertSelection(display, selection, target, prop, window, 0)
        x.XFlush(display)
        deadline = time.monotonic() + 1.0

        def event():
            while not x.XPending(display):
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([x.XConnectionNumber(display)], [], [], remaining)[0]:
                    raise ValueError()
            if time.monotonic() >= deadline:
                raise ValueError()
            result = Event()
            x.XNextEvent(display, c.byref(result))
            return result

        def property_value():
            actual, fmt, count, remaining, data = Atom(), c.c_int(), c.c_ulong(), c.c_ulong(), c.c_void_p()
            try:
                status = x.XGetWindowProperty(display, window, prop, 0, (MAX_BYTES // 4) + 1,
                                              True, 0, c.byref(actual), c.byref(fmt), c.byref(count),
                                              c.byref(remaining), c.byref(data))
                if status or remaining.value or count.value * max(1, fmt.value // 8) > MAX_BYTES:
                    raise ValueError()
                if actual.value == incr and fmt.value == 32 and count.value == 1:
                    if c.cast(data, c.POINTER(c.c_ulong))[0] > MAX_BYTES:
                        raise ValueError()
                    return None
                if actual.value != target or fmt.value != 8:
                    raise ValueError()
                return c.string_at(data, count.value) if count.value else b""
            finally:
                if data:
                    x.XFree(data)
                x.XFlush(display)  # Deleting an INCR property acknowledges this chunk.

        while True:
            notice = event()
            if notice.type != 31:  # SelectionNotify
                continue
            value = notice.selection
            if value.requestor != window or value.selection != selection or value.target != target or value.property != prop:
                raise ValueError()  # Includes property=None: failed conversion, not empty text.
            result = property_value()
            break
        if result is None:
            chunks, size = [], 0
            while True:
                notice = event()
                if notice.type != 28 or notice.property.window != window or notice.property.atom != prop or notice.property.state != 0:
                    continue
                chunk = property_value()
                if chunk is None:
                    raise ValueError()  # INCR is permitted only as the initial property.
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError()
                if not chunk:
                    result = b"".join(chunks)
                    break
                chunks.append(chunk)
        result.decode("utf-8", errors="strict")
        return result
    finally:
        if window:
            x.XDestroyWindow(display, window)
        x.XCloseDisplay(display)


if __name__ == "__main__":
    try:
        contents = read_selection()
    except Exception:
        sys.exit(1)  # Fixed failure status only; never echo data or native exceptions.
    sys.stdout.buffer.write(contents)
