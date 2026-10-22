#!/usr/bin/python3
import ctypes, os, signal, sys
parent = os.getppid()
args = sys.argv[1:]
# Connected Chrome keeps an inherited lock across exec. A restarted server can
# prove cleanup without trusting/killing a saved (possibly reused) numeric PID.
if args[0] == "--private-lock":
    import fcntl
    lock, expected = args[1], int(args[2])
    if parent != expected:
        sys.exit(1)
    ctypes.CDLL(None).prctl(1, signal.SIGKILL)
    fd = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(fd, True)
    args = args[3:]
elif args[0] == "--expected-parent":
    expected = int(args[1])
    if expected <= 1 or os.getppid() != expected:
        sys.exit(1)
    if ctypes.CDLL(None).prctl(1, signal.SIGKILL) != 0:
        sys.exit(1)
    if os.getppid() != expected:
        sys.exit(1)
    args = args[2:]
else:
    ctypes.CDLL(None).prctl(1, signal.SIGTERM)
if os.getppid() != parent:
    sys.exit(1)
os.execvpe(args[0], args, os.environ)
