#!/usr/bin/python3
"""Fixed, bounded X11 cleanup. No screen/clipboard reads or caller-supplied code.

Only Jelly's server supplies the previously native-attested, private binding.
Release can affect physical-user keys/buttons too: the informational full-desktop notice explains this.
"""
import ctypes as c
import hashlib, json, os, stat, sys


def binding_matches(b):
    a = os.stat(b['auth'])
    s = os.lstat(b['socketPath'])
    if not stat.S_ISREG(a.st_mode) or a.st_uid != os.getuid() or a.st_mode & 0o077 or a.st_size > 1048576:
        return False
    with open(b['auth'], 'rb') as f:
        digest = hashlib.sha256(f.read(1048577)).hexdigest()
    return (stat.S_ISSOCK(s.st_mode) and str(s.st_dev) == b['socketDev'] and
            str(s.st_ino) == b['socketIno'] and str(s.st_ctime_ns) == b['socketCtime'] and digest == b['authHash'])


try:
    if len(sys.argv) != 3 or sys.argv[1] not in ('--check', '--release'):
        sys.exit(1)
    b = json.loads(sys.argv[2])
    if not binding_matches(b):
        sys.exit(1)
    os.environ['XAUTHORITY'] = b['auth']
    x = c.CDLL('libX11.so.6')
    xt = c.CDLL('libXtst.so.6')
    xi = c.CDLL('libXi.so.6')
    display = c.c_void_p
    x.XOpenDisplay.argtypes = [c.c_char_p]
    x.XOpenDisplay.restype = display
    x.XDefaultRootWindow.argtypes = [display]
    x.XDefaultRootWindow.restype = c.c_ulong
    x.XQueryKeymap.argtypes = [display, c.c_void_p]
    x.XSync.argtypes = [display, c.c_int]
    x.XCloseDisplay.argtypes = [display]
    x.XFree.argtypes = [c.c_void_p]
    xt.XTestFakeKeyEvent.argtypes = [display, c.c_uint, c.c_int, c.c_ulong]
    xt.XTestFakeButtonEvent.argtypes = [display, c.c_uint, c.c_int, c.c_ulong]
    xt.XTestQueryExtension.argtypes = [display, c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_int)]

    class Buttons(c.Structure):
        _fields_ = [('mask_len', c.c_int), ('mask', c.POINTER(c.c_ubyte))]

    class Mods(c.Structure):
        _fields_ = [('base', c.c_int), ('latched', c.c_int), ('locked', c.c_int), ('effective', c.c_int)]

    class Device(c.Structure):
        _fields_ = [('deviceid', c.c_int), ('name', c.c_char_p), ('use', c.c_int), ('attachment', c.c_int),
                    ('enabled', c.c_int), ('num_classes', c.c_int), ('classes', c.c_void_p)]

    xi.XIQueryDevice.argtypes = [display, c.c_int, c.POINTER(c.c_int)]
    xi.XIQueryDevice.restype = c.POINTER(Device)
    xi.XIFreeDeviceInfo.argtypes = [c.POINTER(Device)]
    xi.XISetClientPointer.argtypes = [display, c.c_ulong, c.c_int]
    xi.XIQueryPointer.argtypes = [display, c.c_int, c.c_ulong, c.POINTER(c.c_ulong), c.POINTER(c.c_ulong),
                               c.POINTER(c.c_double), c.POINTER(c.c_double), c.POINTER(c.c_double), c.POINTER(c.c_double),
                               c.POINTER(Buttons), c.POINTER(Mods), c.POINTER(Mods)]
    d = x.XOpenDisplay(b['display'].encode())
    if not d or not binding_matches(b):
        sys.exit(1)
    event, error, major, minor = c.c_int(), c.c_int(), c.c_int(), c.c_int()
    if not xt.XTestQueryExtension(d, c.byref(event), c.byref(error), c.byref(major), c.byref(minor)):
        sys.exit(1)
    count = c.c_int()
    devices = xi.XIQueryDevice(d, 1, c.byref(count))  # XIAllMasterDevices
    if not devices or count.value < 1 or count.value > 32:
        sys.exit(1)
    pointers = [devices[i].deviceid for i in range(count.value) if devices[i].use == 1 and devices[i].enabled]
    xi.XIFreeDeviceInfo(devices)
    # Multi-master/multiseat input needs a separately reviewed cleanup backend.
    if len(pointers) != 1:
        sys.exit(1)
    device = pointers[0]
    xi.XISetClientPointer(d, 0, device)
    root = x.XDefaultRootWindow(d)

    def pressed():
        keys = (c.c_ubyte * 32)()
        if not x.XQueryKeymap(d, keys):
            raise RuntimeError()
        r, child = c.c_ulong(), c.c_ulong()
        rx, ry, wx, wy = c.c_double(), c.c_double(), c.c_double(), c.c_double()
        buttons, mods, group = Buttons(), Mods(), Mods()
        if not xi.XIQueryPointer(d, device, root, c.byref(r), c.byref(child), c.byref(rx), c.byref(ry),
                               c.byref(wx), c.byref(wy), c.byref(buttons), c.byref(mods), c.byref(group)):
            raise RuntimeError()
        if buttons.mask_len < 0 or buttons.mask_len > 32:
            raise RuntimeError()
        held_buttons = [i for i in range(1, buttons.mask_len * 8) if buttons.mask[i // 8] & (1 << (i % 8))]
        x.XFree(buttons.mask)
        # RFB/XTest input is bounded to the core keyboard and 32 buttons.
        if any(i > 32 for i in held_buttons):
            raise RuntimeError()
        held_keys = [i for i in range(8, 256) if keys[i // 8] & (1 << (i % 8))]
        return held_keys, held_buttons

    keys, buttons = pressed()
    if sys.argv[1] == '--release':
        for key in keys:
            if not xt.XTestFakeKeyEvent(d, key, 0, 0):
                raise RuntimeError()
        for button in buttons:
            if not xt.XTestFakeButtonEvent(d, button, 0, 0):
                raise RuntimeError()
        x.XSync(d, 0)
        if pressed() != ([], []) or not binding_matches(b):
            raise RuntimeError()
    x.XCloseDisplay(d)
except Exception:
    # No paths, key values, typed text, native errors or credentials in output.
    sys.exit(1)
