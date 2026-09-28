#!/usr/bin/python3
import ctypes, os, signal, sys
parent = os.getppid()
ctypes.CDLL(None).prctl(1, signal.SIGTERM)
if os.getppid() != parent:
    sys.exit(1)
os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
