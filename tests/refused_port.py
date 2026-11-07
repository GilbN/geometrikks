"""A loopback port that refuses every connection at once.

Tests that need an unreachable database must not use a closed port. Under
WSL's mirrored networking a connect to a closed 127.0.0.1 port goes to the
Windows host and its refusal never comes back, so each test waited out the
full connect timeout, about 70 seconds (microsoft/WSL#10855). A port held by
a socket that never listens is refused by the Linux kernel itself.
"""
from __future__ import annotations

import socket
from functools import cache


@cache
def _unlistened_socket() -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    return sock


def refused_port() -> int:
    return _unlistened_socket().getsockname()[1]
