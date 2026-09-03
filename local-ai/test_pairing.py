from __future__ import annotations

from pairing import MAX_PAIRING_ATTEMPTS_PER_WINDOW, PairingStore, is_private_client


def expect_raises(error_type, callback):
    try:
        callback()
    except error_type:
        return
    raise AssertionError(f"Expected {error_type.__name__}")


def run():
    assert is_private_client("127.0.0.1")
    assert is_private_client("192.168.1.25")
    assert is_private_client("10.0.0.7")
    assert is_private_client("172.16.10.2")
    assert is_private_client("169.254.10.4")
    assert is_private_client("::1")
    assert is_private_client("fd00::10")
    assert not is_private_client("8.8.8.8")
    assert not is_private_client("100.64.0.1"), "Carrier-grade NAT is not the trusted private LAN allowlist"
    assert not is_private_client("203.0.113.5"), "Documentation/reserved ranges must not be accepted just because ipaddress marks them non-global"
    assert not is_private_client("example.com")

    clock = [1_000.0]
    store = PairingStore(code="ABCDEFGH", now=lambda: clock[0])

    expect_raises(ValueError, lambda: store.pair("192.168.1.20", "WRONG123"))
    expect_raises(PermissionError, lambda: store.pair("8.8.8.8", "ABCDEFGH"))

    session = store.pair("192.168.1.20", "abcdefgh")
    assert store.authorize("192.168.1.20", session.token)
    assert not store.authorize("192.168.1.21", session.token), "Tokens must stay bound to the paired client address"
    assert not store.authorize("192.168.1.20", "wrong-token")

    store.revoke(session.token)
    assert not store.authorize("192.168.1.20", session.token)

    session = store.pair("192.168.1.20", "ABCDEFGH")
    clock[0] += 12 * 60 * 60 + 1
    assert not store.authorize("192.168.1.20", session.token), "Expired sessions must not authorize"

    limited_clock = [2_000.0]
    limited = PairingStore(code="ABCDEFGH", now=lambda: limited_clock[0])
    for _ in range(MAX_PAIRING_ATTEMPTS_PER_WINDOW):
        expect_raises(ValueError, lambda: limited.pair("192.168.1.30", "BADCODE1"))
    expect_raises(RuntimeError, lambda: limited.pair("192.168.1.30", "ABCDEFGH"))
    limited_clock[0] += 61
    assert limited.pair("192.168.1.30", "ABCDEFGH").token

    print("✓ authenticated private-LAN pairing safeguards passed")


if __name__ == "__main__":
    run()
