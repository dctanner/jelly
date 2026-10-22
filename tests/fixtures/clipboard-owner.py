#!/usr/bin/python3
"""Adversarial selection owner, exclusively on a test-supplied disposable X server."""
import ctypes as c
import importlib.util
import pathlib
import sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("reader", pathlib.Path(__file__).parents[2] / "scripts/computer-clipboard-read.py")
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
x = reader.xlib()
D, W, A = reader.Display, reader.Window, reader.Atom
x.XSetSelectionOwner.argtypes = [D, A, W, c.c_ulong]
x.XChangeProperty.argtypes = [D, W, A, A, c.c_int, c.c_int, c.c_void_p, c.c_int]
x.XSendEvent.argtypes = [D, W, c.c_int, c.c_long, c.POINTER(reader.Event)]
class Request(c.Structure):
    _fields_ = [("type", c.c_int), ("serial", c.c_ulong), ("send_event", c.c_int),
                ("display", D), ("owner", W), ("requestor", W), ("selection", A),
                ("target", A), ("property", A), ("time", c.c_ulong)]
d = x.XOpenDisplay(None)
if not d:
    sys.exit(1)
w = x.XCreateSimpleWindow(d, x.XDefaultRootWindow(d), 0, 0, 1, 1, 0, 0, 0)
clipboard = x.XInternAtom(d, b"CLIPBOARD", False)
utf8 = x.XInternAtom(d, b"UTF8_STRING", False)
string = x.XInternAtom(d, b"STRING", False)
incr = x.XInternAtom(d, b"INCR", False)
x.XSetSelectionOwner(d, clipboard, w, 0)
x.XFlush(d)
print("ready", flush=True)
mode, count, transfer = sys.argv[1], 0, None
try:
    while True:
        event = reader.Event()
        x.XNextEvent(d, c.byref(event))
        if event.type == 30:  # SelectionRequest
            request = c.cast(c.byref(event), c.POINTER(Request)).contents
            count += 1
            notice = reader.Event()
            notice.selection = reader.SelectionEvent(31, 0, True, d, request.requestor,
                                                      request.selection, request.target, request.property, request.time)
            if mode == "reject" or mode == "change-owner":
                if mode == "change-owner":
                    x.XSetSelectionOwner(d, clipboard, 0, 0)
                notice.selection.property = 0
            elif mode.startswith("incr"):
                data = b"x" * (262145 if mode == "incr-over" else 262144)
                if mode == "incr-invalid":
                    data = b"ok\xff"
                transfer = [request.requestor, request.property, data, 0]
                x.XSelectInput(d, request.requestor, 1 << 22)
                hint = c.c_ulong(0)  # Unknown length: collector must enforce its own bound.
                x.XChangeProperty(d, request.requestor, request.property, incr, 32, 0, c.byref(hint), 1)
            else:
                bad = mode == "change-format" and count > 1
                payload = b"first" if not bad else b""
                x.XChangeProperty(d, request.requestor, request.property, string if bad else utf8, 8, 0, payload, len(payload))
            x.XSendEvent(d, request.requestor, False, 0, c.byref(notice))
            x.XFlush(d)
        elif event.type == 28 and transfer and event.property.state == 1 and event.property.window == transfer[0] and event.property.atom == transfer[1]:
            requestor, prop, data, offset = transfer
            chunk = data[offset:offset + 16384]
            bad = mode == "incr-format" and offset > 0
            x.XChangeProperty(d, requestor, prop, string if bad else utf8, 8, 0, chunk, len(chunk))
            transfer[3] += len(chunk)
            if not chunk:
                transfer = None
            x.XFlush(d)
finally:
    x.XDestroyWindow(d, w)
    x.XCloseDisplay(d)
