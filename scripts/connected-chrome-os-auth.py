#!/usr/bin/python3
"""Human-only login-keyring authentication on an already owned X11 desktop.

Only GNOME Keyring 50's password-checked control UNLOCK operation is exposed.
No item access, keyring creation, password changes or generic control messages.
Credentials exist only in GTK/process memory and the existing daemon socket.
"""
import json
import hashlib
import os
from pathlib import Path
import socket
import signal
import stat
import struct
import sys

from gi.repository import Gio, GLib

SERVICE = "org.freedesktop.secrets"
COLLECTION = "/org/freedesktop/secrets/collection/login"


class AuthUnavailable(Exception):
    pass


def process_identity(pid):
    proc = Path(f"/proc/{pid}")
    fields = (proc / "stat").read_text().rsplit(")", 1)[1].split()
    exe = os.readlink(proc / "exe")
    if proc.stat().st_uid != os.getuid() or fields[0] == "Z" or Path(exe).name != "gnome-keyring-daemon":
        raise AuthUnavailable()
    return {"pid": pid, "start": fields[19], "exe": exe}


def connection(address):
    # Explicit session bus, no activation/default bus or secret-service discovery.
    return Gio.DBusConnection.new_for_address_sync(address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
        None, None)


def call(bus, destination, path, interface, method, signature, args):
    return bus.call_sync(destination, path, interface, method, GLib.Variant(signature, args),
        None, Gio.DBusCallFlags.NO_AUTO_START, 2000, None).unpack()


def process_stamp(pid):
    # Protected service metadata path: no environ, protected memory or exe read.
    proc = Path(f"/proc/{pid}")
    fields = (proc / "stat").read_text().rsplit(")", 1)[1].split()
    if proc.stat().st_uid != os.getuid() or fields[0] == "Z":
        raise AuthUnavailable()
    return {"pid": pid, "start": fields[19]}


def endpoint(control):
    path = Path(control)
    directory, node = path.parent.lstat(), path.lstat()
    if (not stat.S_ISDIR(directory.st_mode) or directory.st_mode & 0o077 or directory.st_uid != os.getuid() or
            not stat.S_ISSOCK(node.st_mode) or node.st_uid != os.getuid() or os.path.realpath(control) != control):
        raise AuthUnavailable()
    rows = [v.split(maxsplit=7) for v in Path('/proc/net/unix').read_text().splitlines()[1:]]
    rows = [v for v in rows if len(v) == 8 and v[7] == control and int(v[3], 16) & 0x10000 and v[4] == '0001' and v[5] == '01']
    if len(rows) != 1:
        raise AuthUnavailable()
    return [str(node.st_dev), str(node.st_ino), str(node.st_ctime_ns)], rows[0][6]


def owns_listener(pid, inode):
    try:
        for fd in Path(f'/proc/{pid}/fd').iterdir():
            try:
                if os.readlink(fd) == 'socket:[' + inode + ']': return True
            except FileNotFoundError: pass
    except PermissionError:
        return False
    return False


def bus_identity(bus, name):
    owner = call(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner', '(s)', (name,))[0]
    values = [call(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', method, '(s)', (owner,))[0]
              for method in ('GetConnectionUnixProcessID', 'GetConnectionUnixUser')]
    if values[1] != os.getuid(): raise AuthUnavailable()
    return owner, values[0]


def systemd_socket(bus, control, secret_pid):
    try:
        manager, manager_pid = bus_identity(bus, 'org.freedesktop.systemd1')
    except GLib.Error as error:
        if 'NameHasNoOwner' in str(error): return None
        raise AuthUnavailable()
    socket_name, service_name = 'gnome-keyring-daemon.socket', 'gnome-keyring-daemon.service'
    def unit(name):
        return call(bus, manager, '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'GetUnit', '(s)', (name,))[0]
    def prop(path, interface, name):
        return call(bus, manager, path, 'org.freedesktop.DBus.Properties', 'Get', '(ss)', (interface, name))[0]
    ui, si, so = 'org.freedesktop.systemd1.Unit', 'org.freedesktop.systemd1.Service', 'org.freedesktop.systemd1.Socket'
    try: sp = unit(socket_name)
    except GLib.Error as error:
        if 'NoSuchUnit' in str(error): return None
        raise AuthUnavailable()
    listen = prop(sp, so, 'Listen')
    if not any(v[1] == control for v in listen):
        # No foreground fallback for a daemon belonging to the activated service
        # after its configured socket/path changes. Refuse BEFORE Unix connect.
        try:
            if prop(unit(service_name), si, 'MainPID') == secret_pid: raise AuthUnavailable()
        except GLib.Error as error:
            if 'NoSuchUnit' not in str(error): raise AuthUnavailable()
        return None
    # All checks precede Unix connect: never trigger an inactive service.
    dp = unit(service_name)
    if (listen != [('Stream', control)] and listen != [['Stream', control]]) or prop(sp, so, 'Accept') or \
            prop(sp, ui, 'Id') != socket_name or prop(dp, ui, 'Id') != service_name or \
            prop(sp, ui, 'ActiveState') != 'active' or prop(dp, ui, 'ActiveState') != 'active' or \
            prop(sp, ui, 'Triggers') != [service_name] or socket_name not in prop(dp, ui, 'TriggeredBy'):
        raise AuthUnavailable()
    main = prop(dp, si, 'MainPID')
    entries = prop(dp, si, 'ExecStart')
    if main != secret_pid or prop(dp, si, 'ExecMainPID') != main or len(entries) != 1:
        raise AuthUnavailable()
    recorded_pid = entries[0][7]
    if recorded_pid not in (0, main):
        raise AuthUnavailable()
    executable = os.path.realpath(entries[0][0])
    st = os.stat(executable)
    if Path(executable).name != 'gnome-keyring-daemon' or not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
        raise AuthUnavailable()
    if recorded_pid == 0:
        # daemon-reload can discard per-command PID history while the original
        # simple service remains alive. Configured ExecStart alone is not proof:
        # require the live executable/file identity AND its inherited listener.
        # A protected/unreadable executable refuses; never elevate or guess.
        if prop(dp, si, 'Type') != 'simple':
            raise AuthUnavailable()
        actual = os.readlink(f'/proc/{main}/exe')
        live = os.stat(f'/proc/{main}/exe')
        if actual != executable or (live.st_dev, live.st_ino) != (st.st_dev, st.st_ino) or \
                not owns_listener(main, endpoint(control)[1]):
            raise AuthUnavailable()
    group = prop(dp, si, 'ControlGroup')
    if not any(v.endswith(':' + group) for v in Path(f'/proc/{main}/cgroup').read_text().splitlines()):
        raise AuthUnavailable()
    socket_inv, service_inv = [bytes(prop(p, ui, 'InvocationID')).hex() for p in (sp, dp)]
    if any(len(v) != 32 or v == '0' * 32 for v in (socket_inv, service_inv)):
        raise AuthUnavailable()
    return {"manager": {**process_stamp(manager_pid), "owner": manager},
            "socketUnit": {"name": socket_name, "invocation": socket_inv, "service": service_name},
            "serviceUnit": {"name": service_name, "invocation": service_inv, "cgroup": group, "exe": executable,
                            "execHash": hashlib.sha256(json.dumps(entries[0][:3]).encode()).hexdigest()},
            "process": {**process_stamp(main), "exe": executable}}


def snapshot(control, address, expected_kind=None):
    bus = connection(address)
    try:
        # SecretService must already own its name before any control connect.
        owner, pid = bus_identity(bus, SERVICE)
        node, inode = endpoint(control)
        activated = systemd_socket(bus, control, pid)
        kind = 'systemd-socket' if activated else 'direct'
        if expected_kind is not None and kind != expected_kind: raise AuthUnavailable()
        if activated:
            identity = activated['process']
            binding = {"version": 2, "kind": "systemd-socket", **identity,
                       **{k: activated[k] for k in ('manager', 'socketUnit', 'serviceUnit')}}
            peer_pid = activated['manager']['pid']
        else:
            identity = process_identity(pid)
            if not owns_listener(pid, inode): raise AuthUnavailable()
            binding = {"version": 1, "kind": "direct", **identity}
            peer_pid = pid
        # Refuse absent canonical login collection: no keyring creation.
        locked = call(bus, owner, COLLECTION, 'org.freedesktop.DBus.Properties', 'Get', '(ss)',
                      ('org.freedesktop.Secret.Collection', 'Locked'))[0]
        if type(locked) is not bool: raise AuthUnavailable()
        with socket.socket(socket.AF_UNIX) as peer:
            peer.settimeout(2)
            peer.connect(control)
            actual_pid, uid, _ = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != os.getuid() or actual_pid != peer_pid or endpoint(control) != (node, inode) or bus_identity(bus, SERVICE) != (owner, pid):
            raise AuthUnavailable()
        if activated:
            if systemd_socket(bus, control, pid) != activated: raise AuthUnavailable()
        elif process_identity(pid) != identity:
            raise AuthUnavailable()
        return {**binding, "control": control, "bus": address, "owner": owner, "socket": node, "kernelInode": inode}, locked
    finally:
        bus.close_sync(None)


def verified_snapshot(binding):
    if (binding.get('version'), binding.get('kind')) not in ((1, 'direct'), (2, 'systemd-socket')):
        raise AuthUnavailable()
    current, locked = snapshot(binding['control'], binding['bus'], binding['kind'])
    if current != binding: raise AuthUnavailable()
    return current, locked


def unlock(binding, password):
    if not isinstance(password, bytes) or not 1 <= len(password) <= 8192 or b"\0" in password:
        raise AuthUnavailable()
    current, locked = verified_snapshot(binding)
    if not locked:
        return True
    with socket.socket(socket.AF_UNIX) as peer:
        peer.settimeout(3)
        peer.connect(binding["control"])
        pid, uid, _ = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        expected_peer = binding['manager']['pid'] if binding.get('kind') == 'systemd-socket' and binding.get('version') == 2 else binding['pid']
        if uid != os.getuid() or pid != expected_peer:
            raise AuthUnavailable()
        if verified_snapshot(binding)[0] != binding:
            raise AuthUnavailable()
        # GNOME Keyring 50 gkd-control-client.c: credential byte, BE packet size,
        # fixed UNLOCK opcode (1), length-prefixed password. No trailing newline.
        peer.sendall(b"\0" + struct.pack(">III", 12 + len(password), 1, len(password)) + password)
        response = bytearray()
        while len(response) < 8:
            part = peer.recv(8 - len(response))
            if not part:
                raise AuthUnavailable()
            response.extend(part)
    current, locked = verified_snapshot(binding)
    size, result = struct.unpack(">II", response)
    if size != 8 or result not in (0, 1) or (result == 0) == locked:
        raise AuthUnavailable()
    return result == 0


def gtk(binding):
    import gi
    gi.require_version("Gtk", "4.0")
    from gi.repository import Gtk, Gdk
    # No inherited Wayland fallback: launcher supplies only the owned X display.
    if os.environ.get("GDK_BACKEND") != "x11" or os.environ.get("WAYLAND_DISPLAY"):
        raise AuthUnavailable()
    current, initially_locked = verified_snapshot(binding)
    if current != binding:
        raise AuthUnavailable()
    uncertain = False
    app = Gtk.Application(application_id="org.jelly.PrivateOSAuthentication",
                          flags=Gio.ApplicationFlags.NON_UNIQUE)

    def activate(application):
        nonlocal uncertain
        window = Gtk.ApplicationWindow(application=application, title="Private OS authentication")
        window.set_default_size(520, 240)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        for side in ("top", "bottom", "start", "end"):
            getattr(box, "set_margin_" + side)(24)
        label = Gtk.Label(label="Unlock the existing OS login keyring.\nOnly you can see this desktop. Never send this password in chat.")
        box.append(label)
        entry = Gtk.Entry(visibility=False, input_purpose=Gtk.InputPurpose.PASSWORD)
        entry.set_max_length(2048)
        entry.set_input_hints(Gtk.InputHints.PRIVATE | Gtk.InputHints.NO_SPELLCHECK | Gtk.InputHints.NO_EMOJI)
        entry.set_placeholder_text("OS login keyring password")
        box.append(entry)
        button = Gtk.Button(label="Unlock login keyring")
        box.append(button)
        stopped = not initially_locked
        if not initially_locked:
            label.set_text("The OS login keyring is already unlocked. No password is needed.")
            entry.set_visible(False)
            button.set_visible(False)

        def submit(*_args):
            nonlocal stopped, uncertain
            if stopped:
                return
            password = entry.get_text().encode("utf-8")
            entry.set_text("")
            button.set_sensitive(False)
            try:
                success = unlock(binding, password)
                if success:
                    label.set_text("Login keyring unlocked. Return control in Jelly when finished.")
                    entry.set_sensitive(False)
                    entry.set_visible(False)
                    button.set_visible(False)
                    stopped = True
                else:
                    label.set_text("Authentication failed. Enter the OS keyring password to retry.")
                    button.set_sensitive(True)
            except Exception:
                uncertain = True
                entry.set_text("")
                stopped = True
                application.quit()
            finally:
                del password

        button.connect("clicked", submit)
        entry.connect("activate", submit)
        window.set_child(box)
        window.present()
        entry.grab_focus()
        print('{"ready":true}', flush=True)

        def alive():
            nonlocal uncertain
            try:
                if verified_snapshot(binding)[0] == binding:
                    return True
            except Exception:
                pass
            uncertain = True
            entry.set_text("")
            application.quit()
            return False

        GLib.timeout_add(1000, alive)

    # Shutdown is a queued high-priority main-context operation, not process
    # termination in the middle of a submitted native unlock. A synchronous
    # bounded attempt completes (or records uncertainty) before this can run.
    GLib.unix_signal_add(GLib.PRIORITY_HIGH, signal.SIGTERM, lambda: (app.quit(), False)[1])
    app.connect("activate", activate)
    code = app.run([])
    return 1 if uncertain else code


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "--attest":
            print(json.dumps(snapshot(sys.argv[2], sys.argv[3])[0]))
        elif len(sys.argv) == 3 and sys.argv[1] == "--verify":
            print(json.dumps(verified_snapshot(json.loads(sys.argv[2]))[0]))
        elif len(sys.argv) == 3 and sys.argv[1] == "--gtk":
            sys.exit(gtk(json.loads(sys.argv[2])))
        else:
            sys.exit(1)
    except Exception:
        # No raw exception, rejected input, bus path or credentials in diagnostics.
        sys.exit(1)
