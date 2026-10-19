"""Private inherited-listener/systemd metadata simulation, never the host bus."""
import copy, os, socket, subprocess, threading, time
from pathlib import Path


def qualify(auth, bus, root):
    from gi.repository import Gio, GLib
    assert root.name.startswith('jelly-os-auth-')
    control = root / 'inherited'; control.mkdir(mode=0o700)
    listener = socket.socket(socket.AF_UNIX); listener.bind(str(control / 'control')); listener.listen(16)

    argv = ['/usr/bin/gnome-keyring-daemon', '--foreground', '--components=secrets', '--control-directory=' + str(control)]
    # Exec wrapper preserves exact PID and inherited listener, with no secrets
    # in arguments/env and no process protection/dumpability changes.
    wrapper = "import os,sys; os.dup2(int(sys.argv[1]),3); os.set_inheritable(3,True); e=dict(os.environ,LISTEN_PID=str(os.getpid()),LISTEN_FDS='1'); os.execve(sys.argv[2],sys.argv[2:],e)"
    daemon = subprocess.Popen(['/usr/bin/python3', '-c', wrapper, str(listener.fileno()), *argv], pass_fds=(listener.fileno(),), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    loop, registrations = GLib.MainLoop(), []
    original_identity, original_socket = auth.process_identity, auth.socket.socket
    thread = None
    state = {'active': 'active', 'invocation': '2' * 32, 'socketInvocation': '1' * 32,
             'main': daemon.pid, 'service': 'gnome-keyring-daemon.service', 'listen': str(control / 'control'),
             'executable': argv[0], 'socketId': 'gnome-keyring-daemon.socket', 'execPid': daemon.pid, 'type': 'simple'}
    calls = {'connect': 0, 'password': 0}
    class SpySocket(original_socket):
        def connect(self, address):
            calls['connect'] += 1
            return super().connect(address)
        def sendall(self, value, *args):
            if value[:1] == b'\0' and len(value) >= 13: calls['password'] += 1
            return super().sendall(value, *args)
    try:
        for _ in range(100):
            try:
                if auth.bus_identity(bus, auth.SERVICE)[1] == daemon.pid: break
            except Exception: pass
            time.sleep(.02)
        assert auth.bus_identity(bus, auth.SERVICE)[1] == daemon.pid
        group = Path(f'/proc/{daemon.pid}/cgroup').read_text().splitlines()[0].split(':', 2)[2]
        sn, dn = 'gnome-keyring-daemon.socket', 'gnome-keyring-daemon.service'
        sp, dp = '/org/freedesktop/systemd1/unit/socket', '/org/freedesktop/systemd1/unit/service'
        ui, si, so = 'org.freedesktop.systemd1.Unit', 'org.freedesktop.systemd1.Service', 'org.freedesktop.systemd1.Socket'
        declarations = {
            ui: {'Id': 's', 'ActiveState': 's', 'InvocationID': 'ay', 'Triggers': 'as', 'TriggeredBy': 'as'},
            si: {'MainPID': 'u', 'ExecMainPID': 'u', 'ExecStart': 'a(sasbttttuii)', 'ControlGroup': 's', 'Type': 's'},
            so: {'Listen': 'a(ss)', 'Accept': 'b'},
        }
        def value(path, interface, name):
            is_socket = path == sp
            values = {'Id': state['socketId'] if is_socket else dn, 'ActiveState': state['active'],
                      'InvocationID': bytes.fromhex(state['socketInvocation'] if is_socket else state['invocation']),
                      'Triggers': [state['service']] if is_socket else [], 'TriggeredBy': [] if is_socket else [sn],
                      'MainPID': state['main'], 'ExecMainPID': state['main'],
                      'ExecStart': [(state['executable'], argv, False, 0, 0, 0, 0, state['execPid'], 0, 0)],
                      'Type': state['type'],
                      'ControlGroup': group, 'Listen': [('Stream', state['listen'])], 'Accept': False}
            return GLib.Variant(declarations[interface][name], values[name])
        for path, interfaces in ((sp, (ui, so)), (dp, (ui, si))):
            for interface in interfaces:
                xml = '<node><interface name="' + interface + '">' + ''.join('<property name="' + n + '" type="' + t + '" access="read"/>' for n, t in declarations[interface].items()) + '</interface></node>'
                info = Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0]
                registrations.append(bus.register_object(path, info, None, lambda _c, _s, p, i, n: value(p, i, n), None))
        xml = '<node><interface name="org.freedesktop.systemd1.Manager"><method name="GetUnit"><arg type="s" direction="in"/><arg type="o" direction="out"/></method></interface></node>'
        def method(_c, _sender, _path, _interface, _method, params, invocation):
            name = params.unpack()[0]
            if name not in (sn, dn): invocation.return_dbus_error('org.freedesktop.systemd1.NoSuchUnit', 'Missing private fixture unit')
            else: invocation.return_value(GLib.Variant('(o)', (sp if name == sn else dp,)))
        registrations.append(bus.register_object('/org/freedesktop/systemd1', Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0], method, None, None))
        assert auth.call(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', '(su)', ('org.freedesktop.systemd1', 0))[0] == 1
        thread = threading.Thread(target=loop.run); thread.start()
        # Simulate protected exe metadata: the systemd branch must NEVER use it.
        def protected(_pid): raise AssertionError('Protected exe path was read')
        auth.process_identity, auth.socket.socket = protected, SpySocket
        binding, _ = auth.snapshot(str(control / 'control'), os.environ['DBUS_SESSION_BUS_ADDRESS'])
        assert binding['version'] == 2 and binding['kind'] == 'systemd-socket'
        assert binding['pid'] == daemon.pid and binding['manager']['pid'] == os.getpid()
        auth.call(bus, binding['owner'], '/org/freedesktop/secrets', 'org.freedesktop.Secret.Service', 'Lock', '(ao)', ([auth.COLLECTION],))
        assert auth.unlock(binding, b'wrong-disposable-passphrase') is False
        assert auth.snapshot(binding['control'], binding['bus'])[1]
        assert auth.unlock(binding, b'disposable-fixture-passphrase') is True
        assert not auth.snapshot(binding['control'], binding['bus'])[1]
        # Reloaded user units can lose ExecStart PID history without replacing
        # the active service. The same binding must still require a real live
        # executable and inherited listener, never only the new unit settings.
        state['execPid'] = 0
        reloaded, _ = auth.snapshot(str(control / 'control'), os.environ['DBUS_SESSION_BUS_ADDRESS'])
        assert reloaded == binding
        auth.call(bus, binding['owner'], '/org/freedesktop/secrets', 'org.freedesktop.Secret.Service', 'Lock', '(ao)', ([auth.COLLECTION],))
        assert auth.unlock(binding, b'wrong-disposable-passphrase') is False
        assert auth.unlock(binding, b'disposable-fixture-passphrase') is True
        saved_readlink, saved_listener = auth.os.readlink, auth.owns_listener
        before = dict(calls)
        def inaccessible(path, *args, **kwargs):
            if str(path) == f'/proc/{daemon.pid}/exe': raise PermissionError()
            return saved_readlink(path, *args, **kwargs)
        try:
            auth.os.readlink = inaccessible
            try: auth.verified_snapshot(binding)
            except Exception: pass
            else: raise AssertionError('Unknown executable admitted after reload')
            assert calls == before
        finally: auth.os.readlink = saved_readlink
        try:
            auth.owns_listener = lambda *_args: False
            try: auth.verified_snapshot(binding)
            except Exception: pass
            else: raise AssertionError('Missing inherited listener admitted after reload')
            assert calls == before
        finally: auth.owns_listener = saved_listener
        state['type'] = 'forking'
        try:
            auth.verified_snapshot(binding)
        except Exception: pass
        else: raise AssertionError('Unsupported reloaded service type admitted')
        assert calls == before
        state['type'] = 'simple'
        # Keep the cleared command history for the complete GTK/noVNC fixture,
        # matching an already-running service after daemon-reload on this host.
        sent = calls['password']
        assert sent == 4
        # Negative cases must not rely on our protected-metadata simulation.
        auth.process_identity = original_identity
        for field, bad in (('invocation', '3' * 32), ('socketInvocation', '4' * 32), ('main', os.getpid()), ('execPid', os.getpid()), ('service', 'different.service'), ('listen', str(control / 'different')), ('active', 'inactive'), ('executable', '/usr/bin/dbus-daemon'), ('socketId', 'different.socket')):
            old = state[field]; state[field] = bad
            before_connect = calls['connect']
            try:
                auth.unlock(binding, b'disposable-fixture-passphrase')
            except Exception: pass
            else: raise AssertionError('Changed inherited binding admitted')
            assert calls['password'] == sent
            if field in ('main', 'service', 'listen', 'active', 'executable', 'socketId'): assert calls['connect'] == before_connect
            state[field] = old
        for field in ('manager', 'socketUnit', 'serviceUnit'):
            bad = copy.deepcopy(binding)
            bad[field]['start' if field == 'manager' else 'invocation'] = '0'
            try: auth.unlock(bad, b'disposable-fixture-passphrase')
            except Exception: pass
            else: raise AssertionError('Forged inherited generation admitted')
            assert calls['password'] == sent
        original_call = auth.call
        def wrong_uid(b, destination, path, interface, method, signature, args):
            if method == 'GetConnectionUnixUser' and args == (binding['manager']['owner'],): return (os.getuid() + 1,)
            return original_call(b, destination, path, interface, method, signature, args)
        before_connect = calls['connect']
        try:
            auth.call = wrong_uid
            try: auth.unlock(binding, b'disposable-fixture-passphrase')
            except Exception: pass
            else: raise AssertionError('Unauthenticated manager admitted')
            assert calls['connect'] == before_connect and calls['password'] == sent
        finally: auth.call = original_call
        if os.environ.get('JELLY_AUTH_BROWSER_FIXTURE') == '1':
            auth.call(bus, binding['owner'], '/org/freedesktop/secrets', 'org.freedesktop.Secret.Service', 'Lock', '(ao)', ([auth.COLLECTION],))
            child = subprocess.run(['/usr/local/bin/bun', str(Path(__file__).resolve().parents[1] / 'owned-chrome-desktop.browser.ts')],
                                   env={**os.environ, 'FIXTURE_CONTROL': str(control / 'control')}, timeout=150)
            assert child.returncode == 0
        if daemon.poll() is None: daemon.terminate(); daemon.wait(timeout=3)
        before_connect = calls['connect']
        try: auth.snapshot(binding['control'], binding['bus'])
        except Exception: pass
        else: raise AssertionError('Inactive daemon admitted')
        assert calls['connect'] == before_connect and calls['password'] == sent
        return {'inherited_listener_protected_metadata_proof': True, 'systemd_wrong_generation_service_socket_refused': True,
                'inactive_service_never_connected_or_activated': True, 'inherited_wrong_correct_same_login_unlock': True}
    finally:
        auth.process_identity, auth.socket.socket = original_identity, original_socket
        if daemon.poll() is None: daemon.terminate(); daemon.wait(timeout=3)
        loop.quit()
        if thread: thread.join(timeout=3)
        for registration in registrations: bus.unregister_object(registration)
        auth.call(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ReleaseName', '(s)', ('org.freedesktop.systemd1',))
        listener.close()
