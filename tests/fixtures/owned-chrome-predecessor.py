#!/usr/bin/python3
"""Actual disposable Chrome listener + synthetic unit metadata; never queries a unit."""
import importlib.util, json, os, socket, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('unit', Path(__file__).resolve().parents[2] / 'scripts/connected-chrome-unit.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
e = json.loads(sys.argv[1])
assert e['root'].startswith('/tmp/jelly-owned-chrome-test-')
p = m.process(e['pid'])
assert p == {k: e[k] for k in ('pid', 'start', 'exe')}
raw = Path(f"/proc/{p['pid']}/cmdline").read_bytes()
try: raw_env = Path(f"/proc/{p['pid']}/environ").read_bytes()
except PermissionError: raw_env = b''
selected, unsafe = m.environment(raw_env)
assert not selected.get('HOME') and raw.count(b'\0') <= 1
proof = m.predecessor_listener(e['root'], p['pid'])
s = dict(unit=e['unit'], mainPid=p['pid'], execPid=p['pid'], invocation=e['invocation'],
         cgroup='/synthetic/' + e['unit'], cgroupBound=True, executableBound=True,
         argv=[p['exe'], '--user-data-dir=' + e['root'], '--profile-directory=' + e['profile']],
         environment=selected, unsafeArguments=bool(m.UNSAFE.search(raw)), unsafeEnvironment=unsafe,
         rootOverrides=m.override_count(raw, 'user-data-dir'), profileOverrides=m.override_count(raw, 'profile-directory'),
         process=p, rootProof={**proof, 'rootIdentity': m.selected_directory(e['root']),
                               'profileIdentity': m.selected_directory(str(Path(e['root']) / e['profile']))})
m.validate_predecessor(s, e)
try: m.validate_metadata(s, e)
except RuntimeError: pass
else: raise AssertionError('General HOME proof unexpectedly accepted')
for field, value in (('invocation', '0' * 32), ('mainPid', p['pid'] + 1)):
    bad = {**s, field: value}
    try: m.validate_predecessor(bad, e)
    except RuntimeError: pass
    else: raise AssertionError('Wrong predecessor generation admitted')
for name, value in (('user-data-dir', '/different'), ('profile-directory', 'Different')):
    argv = [v if not v.startswith('--' + name + '=') else '--' + name + '=' + value for v in s['argv']]
    try: m.validate_predecessor({**s, 'argv': argv}, e)
    except RuntimeError: pass
    else: raise AssertionError('Explicit mismatch admitted')
# Fabricated artifacts, NOT the actual browser locks/profile. A different process
# owns this listening socket even though the fake lock names the Chrome MainPID.
with tempfile.TemporaryDirectory(prefix='jelly-predecessor-negative-') as tmp:
    fake = Path(tmp)
    with socket.socket(socket.AF_UNIX) as other:
        other.bind(str(fake / 'control')); other.listen(1)
        os.symlink(socket.gethostname() + '-' + str(p['pid']), fake / 'SingletonLock')
        os.symlink(str(fake / 'control'), fake / 'SingletonSocket')
        os.symlink('synthetic-not-cookie-material', fake / 'SingletonCookie')
        try: m.predecessor_listener(str(fake), p['pid'])
        except RuntimeError: pass
        else: raise AssertionError('Different listener process admitted')
assert m.process(p['pid']) == p and m.predecessor_listener(e['root'], p['pid']) == proof
print('PASS: predecessor-only root/listening kernel inode proof with real flattened/erased-environ private Chrome; explicit mismatch and different owner refuse; no unit query.')
