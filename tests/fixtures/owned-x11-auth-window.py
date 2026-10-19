#!/usr/bin/python3
"""Read geometry only of the disposable fixture's exact GTK auth window."""
import ctypes as c
import json
import os

assert os.environ["XAUTHORITY"].startswith("/tmp/jelly-owned-chrome-test-")
x = c.CDLL("libX11.so.6")
x.XOpenDisplay.argtypes = [c.c_char_p]
x.XOpenDisplay.restype = c.c_void_p
x.XDefaultRootWindow.argtypes = [c.c_void_p]
x.XDefaultRootWindow.restype = c.c_ulong
x.XQueryTree.argtypes = [c.c_void_p, c.c_ulong, c.POINTER(c.c_ulong), c.POINTER(c.c_ulong), c.POINTER(c.POINTER(c.c_ulong)), c.POINTER(c.c_uint)]
x.XFetchName.argtypes = [c.c_void_p, c.c_ulong, c.POINTER(c.c_char_p)]
x.XTranslateCoordinates.argtypes = [c.c_void_p, c.c_ulong, c.c_ulong, c.c_int, c.c_int, c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_ulong)]
x.XFree.argtypes = [c.c_void_p]
x.XCloseDisplay.argtypes = [c.c_void_p]
d = x.XOpenDisplay(os.environ["DISPLAY"].encode())
assert d
root = x.XDefaultRootWindow(d)


def visit(window, depth=0):
    if depth > 4:
        return None
    name = c.c_char_p()
    x.XFetchName(d, window, c.byref(name))
    match = name.value == b"Private OS authentication"
    if name:
        x.XFree(name)
    if match:
        px, py, child = c.c_int(), c.c_int(), c.c_ulong()
        assert x.XTranslateCoordinates(d, window, root, 0, 0, c.byref(px), c.byref(py), c.byref(child))
        return {"x": px.value, "y": py.value}
    returned_root, parent = c.c_ulong(), c.c_ulong()
    children, count = c.POINTER(c.c_ulong)(), c.c_uint()
    if not x.XQueryTree(d, window, c.byref(returned_root), c.byref(parent), c.byref(children), c.byref(count)):
        return None
    result = None
    for i in range(min(count.value, 200)):
        result = visit(children[i], depth + 1)
        if result:
            break
    if children:
        x.XFree(children)
    return result


try:
    result = visit(root)
    assert result
    print(json.dumps(result))
finally:
    x.XCloseDisplay(d)
