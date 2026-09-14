"""Pure selection policy mirrored by select_lan_ipv4.ps1 for test coverage."""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass

VIRTUAL_WORDS = ("loopback", "vethernet", "hyper-v", "vmware", "virtualbox", "tailscale", "wireguard", "openvpn", "vpn", "docker", "wsl", "ndiswan", "tap", "zerotier")
NORMAL_WORDS = ("wi-fi", "wifi", "wireless", "ethernet", "802.3")


@dataclass(frozen=True)
class Candidate:
    name: str
    address: str
    up: bool = True
    gateway: bool = True
    metric: int = 9999


def valid_lan_ipv4(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return isinstance(address, ipaddress.IPv4Address) and address.is_private and not address.is_loopback and not address.is_link_local


def select_candidates(candidates: list[Candidate]) -> list[Candidate]:
    valid = [item for item in candidates if item.up and valid_lan_ipv4(item.address) and not any(word in item.name.lower() for word in VIRTUAL_WORDS)]
    normal = [item for item in valid if any(word in item.name.lower() for word in NORMAL_WORDS)]
    if normal:
        valid = normal
    with_gateway = [item for item in valid if item.gateway]
    if with_gateway:
        valid = with_gateway
    return sorted(valid, key=lambda item: (item.metric, item.name.lower(), item.address))
