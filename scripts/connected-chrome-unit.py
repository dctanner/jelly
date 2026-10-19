#!/usr/bin/python3
"""Read-only predecessor-unit attestation. No capture/input/auth or raw env/argv output."""
import json, os, re, stat, sys
from socket import gethostname

ROOT_ENV = {b'HOME', b'XDG_CONFIG_HOME', b'CHROME_CONFIG_HOME', b'CHROME_USER_DATA_DIR',
            b'DISPLAY', b'XAUTHORITY', b'WAYLAND_DISPLAY', b'XDG_SESSION_TYPE'}
KNOWN_CHROME_ENV = ROOT_ENV | {b'CHROME_WRAPPER', b'CHROME_DESKTOP', b'CHROME_DEVEL_SANDBOX'}
UNSAFE = re.compile(rb'(?:^|[\x00\s=])-{1,2}(?:remote-debugging|headless|no-sandbox|disable-setuid-sandbox|password-store|type)(?:[-=\x00\s]|$)')


def environment(raw):
    selected, unsafe = {}, False
    for entry in raw.split(b'\0'):
        key, _, value = entry.partition(b'=')
        if key.startswith(b'CHROME_') and key not in KNOWN_CHROME_ENV:
            unsafe = True
        if key in ROOT_ENV:
            selected[key.decode('ascii')] = value.decode('utf-8', 'strict')
    return selected, unsafe


def override_count(raw, name):
    return len(re.findall(rb'(?:^|[\x00\s])-{1,2}' + name.encode() + rb'(?:=|[\x00\s]|$)', raw))


def argument(argv, name):
    values = []
    for i, token in enumerate(argv[1:], 1):
        for prefix in ('--' + name, '-' + name):
            if token == prefix:
                if i + 1 >= len(argv) or argv[i + 1].startswith('-'):
                    raise RuntimeError('Missing structured argument')
                values.append(argv[i + 1])
            elif token.startswith(prefix + '='):
                values.append(token[len(prefix) + 1:])
    if len(values) > 1 or any(not v or '\0' in v for v in values):
        raise RuntimeError('Ambiguous structured argument')
    return values


def validate_identity_and_flags(s, e):
    """Only structured unit argv supplies values; flattened argv supplies denials/counts."""
    if (s['unit'] != e['unit'] or s['mainPid'] != e['pid'] or s['execPid'] != e['pid'] or
            not re.fullmatch('[0-9a-f]{32}', s['invocation']) or s['invocation'] == '0' * 32 or
            not s['cgroup'].endswith('/' + e['unit']) or not s['cgroupBound'] or
            not s['executableBound'] or s['unsafeArguments'] or s['unsafeEnvironment']):
        raise RuntimeError('Unproven unit identity')
    argv = s['argv']
    if not argv or any(UNSAFE.search(v.encode()) for v in argv):
        raise RuntimeError('Unsafe structured arguments')
    roots, profiles = argument(argv, 'user-data-dir'), argument(argv, 'profile-directory')
    if s['rootOverrides'] != len(roots) or s['profileOverrides'] != len(profiles):
        raise RuntimeError('Unaccounted actual override')
    if e.get('invocation') and s['invocation'] != e['invocation']:
        raise RuntimeError('Unexpected predecessor InvocationID')
    if e.get('start') and s['process'] != {k: e[k] for k in ('pid', 'start', 'exe')}:
        raise RuntimeError('Unexpected predecessor process generation')
    return roots, profiles


def validate_metadata(s, e):
    roots, profiles = validate_identity_and_flags(s, e)
    env = s['environment']
    if env.get('CHROME_CONFIG_HOME') or env.get('CHROME_USER_DATA_DIR'):
        raise RuntimeError('Unsupported Chrome environment override')
    home = env.get('HOME')
    if not home or not os.path.isabs(home) or os.path.normpath(home) != e['home']:
        raise RuntimeError('Unproven browser HOME')
    base = env.get('XDG_CONFIG_HOME') or os.path.join(home, '.config')
    if not os.path.isabs(base):
        raise RuntimeError('Unproven config root')
    root = roots[0] if roots else os.path.join(base, 'google-chrome')
    if not os.path.isabs(root) or os.path.normpath(root) != e['root'] or (profiles[0] if profiles else 'Default') != e['profile']:
        raise RuntimeError('Unproven selected profile')


def selected_directory(path):
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode) or st.st_uid != os.getuid() or os.path.realpath(path) != path:
        raise RuntimeError('Untrusted selected directory')
    return dict(path=path, dev=str(st.st_dev), ino=str(st.st_ino), uid=st.st_uid)


def predecessor_listener(root, pid):
    """Filesystem socket inode is NOT its kernel Unix inode. Never read cookie target."""
    locks = {}
    for name in ('SingletonLock', 'SingletonSocket', 'SingletonCookie'):
        st = os.lstat(os.path.join(root, name))
        if not stat.S_ISLNK(st.st_mode) or st.st_uid != os.getuid():
            raise RuntimeError('Untrusted singleton')
        locks[name] = dict(dev=str(st.st_dev), ino=str(st.st_ino), ctime=str(st.st_ctime_ns))
    if os.readlink(os.path.join(root, 'SingletonLock')) != gethostname() + '-' + str(pid):
        raise RuntimeError('Different singleton owner')
    path = os.readlink(os.path.join(root, 'SingletonSocket'))
    if not os.path.isabs(path) or os.path.realpath(path) != path:
        raise RuntimeError('Ambiguous singleton endpoint')
    st, parent = os.lstat(path), os.lstat(os.path.dirname(path))
    if (not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.getuid() or not stat.S_ISDIR(parent.st_mode) or
            parent.st_uid != os.getuid() or parent.st_mode & 0o077):
        raise RuntimeError('Untrusted singleton endpoint')
    rows = [v.split(maxsplit=7) for v in open('/proc/net/unix').read().splitlines()[1:]]
    listeners = [v for v in rows if len(v) == 8 and v[7] == path and int(v[3], 16) & 0x10000 and v[4] == '0001' and v[5] == '01']
    if len(listeners) != 1:
        raise RuntimeError('Ambiguous listening endpoint')
    inode = listeners[0][6]
    targets = []
    for fd in os.listdir('/proc/' + str(pid) + '/fd'):
        try: targets.append(os.readlink('/proc/' + str(pid) + '/fd/' + fd))
        except FileNotFoundError: pass
    if 'socket:[' + inode + ']' not in targets:
        raise RuntimeError('MainPID does not own exact listening kernel inode')
    return dict(locks=locks, path=path, socket=[str(st.st_dev), str(st.st_ino), str(st.st_ctime_ns)], kernelInode=inode)


def validate_predecessor(s, e):
    # PREDECESSOR ONLY: proves chosen-root ownership, not active profile windows,
    # native automation authority, unsaved-state safety or a HOME/env fallback.
    if not e.get('invocation') or not e.get('start'):
        raise RuntimeError('Expected predecessor generation required')
    roots, profiles = validate_identity_and_flags(s, e)
    if roots and (not os.path.isabs(roots[0]) or os.path.normpath(roots[0]) != e['root']):
        raise RuntimeError('Explicit predecessor root mismatch')
    if profiles and profiles[0] != e['profile']:
        raise RuntimeError('Explicit predecessor profile mismatch')
    if not s.get('rootProof') or len(s['rootProof']['locks']) != 3:
        raise RuntimeError('Missing selected-root listener proof')
    for name in ('rootIdentity', 'profileIdentity'):
        if e.get(name) and s['rootProof'].get(name) != e[name]: raise RuntimeError('Selected directory changed')


def process(pid):
    path = '/proc/' + str(pid)
    if os.stat(path).st_uid != os.getuid():
        raise RuntimeError('Wrong process user')
    tail = open(path + '/stat').read().rsplit(')', 1)[1].split()
    if tail[0] == 'Z':
        raise RuntimeError('Dead process')
    return {'pid': pid, 'start': tail[19], 'exe': os.readlink(path + '/exe')}


def attest(e):
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio, GLib
    bus = Gio.DBusConnection.new_for_address_sync('unix:path=/run/user/' + str(os.getuid()) + '/bus',
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)

    def call(dest, path, interface, method, signature, values):
        return bus.call_sync(dest, path, interface, method, GLib.Variant(signature, values), None,
                             Gio.DBusCallFlags.NO_AUTO_START, 1500, None).unpack()

    def owner():
        return call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                    'GetNameOwner', '(s)', ('org.freedesktop.systemd1',))[0]

    service = owner()
    uid = call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
               'GetConnectionUnixUser', '(s)', (service,))[0]
    if uid != os.getuid():
        raise RuntimeError('Wrong user manager')

    def snapshot():
        if not re.fullmatch('[A-Za-z0-9 _-]{1,80}', e['profile']): raise RuntimeError('Invalid selected profile')
        path = call(service, '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager',
                    'GetUnit', '(s)', (e['unit'],))[0]

        def prop(interface, name):
            return call(service, path, 'org.freedesktop.DBus.Properties', 'Get', '(ss)', (interface, name))[0]

        si, ui = 'org.freedesktop.systemd1.Service', 'org.freedesktop.systemd1.Unit'
        if prop(ui, 'ActiveState') != 'active' or prop(si, 'EnvironmentFiles'):
            raise RuntimeError('Unsupported unit state/environment')
        main = prop(si, 'MainPID')
        entries = prop(si, 'ExecStart')
        if main != e['pid'] or len(entries) != 1:
            raise RuntimeError('Unsupported unit main process')
        entry = entries[0]
        p = process(main)
        raw = open('/proc/' + str(main) + '/cmdline', 'rb').read(1048577)
        try: raw_env = open('/proc/' + str(main) + '/environ', 'rb').read(1048577)
        except PermissionError: raw_env = b''
        if len(raw) > 1048576 or len(raw_env) > 1048576:
            raise RuntimeError('Oversized process metadata')
        selected, unsafe_env = environment(raw_env)
        cgroup = prop(si, 'ControlGroup')
        groups = open('/proc/' + str(main) + '/cgroup').read().splitlines()
        binary = os.path.realpath(e['binary'])
        executable = os.path.realpath(entry[0])
        st = os.stat(executable)
        # Direct binary, or the root-owned official stable Chrome wrapper only.
        wrapper = (os.path.basename(executable) == 'google-chrome' and st.st_uid == 0 and
                   not st.st_mode & 0o022 and p['exe'] == os.path.join(os.path.dirname(executable), 'chrome'))
        return {'unit': e['unit'], 'mainPid': main, 'execPid': entry[7],
                'invocation': bytes(prop(ui, 'InvocationID')).hex(), 'cgroup': cgroup,
                'cgroupBound': any(v.endswith(':' + cgroup) for v in groups),
                'executableBound': binary == executable and (p['exe'] == executable or wrapper),
                'argv': list(entry[1]), 'environment': selected, 'unsafeEnvironment': unsafe_env,
                'unsafeArguments': bool(UNSAFE.search(raw)), 'rootOverrides': override_count(raw, 'user-data-dir'),
                'profileOverrides': override_count(raw, 'profile-directory'), 'process': p,
                'rootProof': {**predecessor_listener(e['root'], main), 'rootIdentity': selected_directory(e['root']),
                              'profileIdentity': selected_directory(os.path.join(e['root'], e['profile']))}}

    before = snapshot()
    validate_predecessor(before, e)
    after = snapshot()
    if before != after or owner() != service:
        raise RuntimeError('Changed unit/process generation')
    return {'browser': before['process'], 'invocation': before['invocation'], 'rootProof': before['rootProof']}


if __name__ == '__main__':
    try:
        expected = json.loads(sys.argv[1])
        result = attest(expected)
        # Fixed metadata only. No unit argv, environment, profile data or native errors.
        print(json.dumps(result))
    except Exception:
        sys.exit(1)
