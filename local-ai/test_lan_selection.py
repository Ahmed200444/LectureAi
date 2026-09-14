from lan_selection import Candidate, select_candidates, valid_lan_ipv4


def run():
    # A: normal Wi-Fi wins over WSL/vEthernet.
    assert [item.address for item in select_candidates([Candidate("Wi-Fi", "192.168.1.24", metric=25), Candidate("vEthernet (WSL)", "172.20.0.1", metric=5)])] == ["192.168.1.24"]
    # B: Ethernet wins over a VPN adapter.
    assert [item.address for item in select_candidates([Candidate("Ethernet", "10.0.0.8", metric=25), Candidate("Corporate VPN", "10.8.0.2", metric=5)])] == ["10.0.0.8"]
    # C: two ordinary, gateway-backed adapters remain an explicit ordered choice.
    assert [item.address for item in select_candidates([Candidate("Wi-Fi", "192.168.1.24", metric=25), Candidate("Ethernet", "10.0.0.8", metric=10)])] == ["10.0.0.8", "192.168.1.24"]
    # D/E/F: APIPA, no network, public, malformed, and loopback are not candidates.
    assert not select_candidates([Candidate("Wi-Fi", "169.254.4.2")])
    assert not select_candidates([])
    assert not valid_lan_ipv4("8.8.8.8") and not valid_lan_ipv4("") and not valid_lan_ipv4("127.0.0.1")
    print("[PASS] Windows LAN candidate selection safeguards passed")


if __name__ == "__main__":
    run()
