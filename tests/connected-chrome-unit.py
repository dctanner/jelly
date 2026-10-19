#!/usr/bin/python3
"""Synthetic unit-data tests only: no D-Bus, unit query or host process inspection."""
import copy, importlib.util, pathlib, unittest
spec = importlib.util.spec_from_file_location('unit', pathlib.Path(__file__).resolve().parents[1] / 'scripts/connected-chrome-unit.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class UnitProof(unittest.TestCase):
    def fixture(self):
        e = dict(unit='jelly-fixture.service', pid=123, root='/fixture/home/.config/google-chrome',
                 home='/fixture/home', profile='Default')
        s = dict(unit=e['unit'], mainPid=123, execPid=123, invocation='a' * 32,
                 cgroup='/user.slice/jelly-fixture.service', cgroupBound=True, executableBound=True,
                 argv=['/opt/google/chrome/google-chrome', '--no-first-run'],
                 environment={'HOME': '/fixture/home'}, unsafeArguments=False, unsafeEnvironment=False,
                 rootOverrides=0, profileOverrides=0)
        return s, e

    def test_genuine_default_root(self):
        s, e = self.fixture()
        m.validate_metadata(s, e)

    def test_structured_explicit_root_and_spaced_profile(self):
        s, e = self.fixture()
        e.update(root='/fixture/existing root', profile='Profile 1')
        s.update(argv=['/opt/chrome', '--user-data-dir', e['root'], '--profile-directory=' + e['profile']], rootOverrides=1, profileOverrides=1)
        m.validate_metadata(s, e)

    def test_no_default_around_actual_or_structured_override(self):
        for name in ('rootOverrides', 'profileOverrides'):
            s, e = self.fixture(); s[name] = 1
            with self.assertRaises(RuntimeError): m.validate_metadata(s, e)
        s, e = self.fixture(); s['argv'].append('--user-data-dir=/different'); s['rootOverrides'] = 1
        with self.assertRaises(RuntimeError): m.validate_metadata(s, e)

    def test_duplicate_missing_or_single_dash_override(self):
        for argv in (['--user-data-dir'], ['--user-data-dir=/a', '-user-data-dir=/b'], ['-user-data-dir=/different']):
            s, e = self.fixture(); s['argv'] += argv; s['rootOverrides'] = 1
            with self.assertRaises(RuntimeError): m.validate_metadata(s, e)

    def test_flattened_unsafe_switches_both_aliases(self):
        for prefix in ('-', '--'):
            for flag in ('remote-debugging-port=9222', 'remote-debugging-pipe', 'headless=new', 'no-sandbox', 'disable-setuid-sandbox', 'password-store=basic', 'type=utility'):
                raw = ('/opt/chrome --no-first-run ' + prefix + flag + ' --user-data-dir=/fixture').encode()
                self.assertTrue(m.UNSAFE.search(raw))
                s, e = self.fixture(); s['unsafeArguments'] = bool(m.UNSAFE.search(raw))
                with self.assertRaises(RuntimeError): m.validate_metadata(s, e)
                s, e = self.fixture(); s['argv'].append(prefix + flag)
                with self.assertRaises(RuntimeError): m.validate_metadata(s, e)
        raw = b'/opt/chrome --user-data-dir=/fixture -profile-directory=Default\0'
        self.assertEqual(m.override_count(raw, 'user-data-dir'), 1)
        self.assertEqual(m.override_count(raw, 'profile-directory'), 1)

    def test_unknown_chrome_environment_and_known_root_override_refuse(self):
        selected, unsafe = m.environment(b'HOME=/fixture/home\0CHROME_FLAGS=anything\0UNRELATED_SECRET=never-output\0DISPLAY=:99\0')
        self.assertTrue(unsafe)
        self.assertNotIn('UNRELATED_SECRET', selected)
        self.assertNotIn('CHROME_FLAGS', selected)
        self.assertEqual(selected['DISPLAY'], ':99')
        for key in ('CHROME_CONFIG_HOME', 'CHROME_USER_DATA_DIR'):
            s, e = self.fixture(); s['environment'][key] = '/other'
            with self.assertRaises(RuntimeError): m.validate_metadata(s, e)
        s, e = self.fixture(); s['unsafeEnvironment'] = True
        with self.assertRaises(RuntimeError): m.validate_metadata(s, e)

    def test_home_xdg_config_and_profile_binding(self):
        for env in ({}, {'HOME': '/wrong'}, {'HOME': '/fixture/home', 'XDG_CONFIG_HOME': 'relative'}, {'HOME': '/fixture/home', 'XDG_CONFIG_HOME': '/other'}):
            s, e = self.fixture(); s['environment'] = env
            with self.assertRaises(RuntimeError): m.validate_metadata(s, e)
        s, e = self.fixture(); s['environment']['XDG_CONFIG_HOME'] = '/fixture/xdg'; e['root'] = '/fixture/xdg/google-chrome'
        m.validate_metadata(s, e)

    def test_identity_generation_executable_and_cgroup_fail_closed(self):
        for key, value in (('unit', 'different.service'), ('mainPid', 124), ('execPid', 124), ('invocation', '0' * 32), ('invocation', ''), ('cgroup', '/other.service'), ('cgroupBound', False), ('executableBound', False)):
            s, e = self.fixture(); s[key] = value
            with self.assertRaises(RuntimeError): m.validate_metadata(s, e)


if __name__ == '__main__':
    unittest.main()
