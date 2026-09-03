from __future__ import annotations

import ipaddress
import secrets
import string
import threading
import time
from dataclasses import dataclass

PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
SESSION_TTL_SECONDS = 12 * 60 * 60
PAIRING_WINDOW_SECONDS = 60
MAX_PAIRING_ATTEMPTS_PER_WINDOW = 10


def generate_pairing_code(length: int = 8) -> str:
    return "".join(secrets.choice(PAIRING_ALPHABET) for _ in range(length))


def is_private_client(host: str | None) -> bool:
    if not host:
        return False
    if host in {"localhost", "::1"}:
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return bool(address.is_loopback or address.is_private or address.is_link_local)


@dataclass(frozen=True)
class Session:
    token: str
    client_host: str
    expires_at: float


class PairingStore:
    def __init__(self, code: str | None = None, now=time.time):
        self.code = (code or generate_pairing_code()).upper()
        self._now = now
        self._sessions: dict[str, Session] = {}
        self._attempts: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def _cleanup_locked(self) -> None:
        now = self._now()
        expired = [token for token, session in self._sessions.items() if session.expires_at <= now]
        for token in expired:
            self._sessions.pop(token, None)
        cutoff = now - PAIRING_WINDOW_SECONDS
        for host, attempts in list(self._attempts.items()):
            recent = [stamp for stamp in attempts if stamp > cutoff]
            if recent:
                self._attempts[host] = recent
            else:
                self._attempts.pop(host, None)

    def pair(self, client_host: str, submitted_code: str) -> Session:
        if not is_private_client(client_host):
            raise PermissionError("Pairing is allowed only from the same private/local network.")
        with self._lock:
            self._cleanup_locked()
            attempts = self._attempts.setdefault(client_host, [])
            if len(attempts) >= MAX_PAIRING_ATTEMPTS_PER_WINDOW:
                raise RuntimeError("Too many pairing attempts. Wait a minute and try again.")
            attempts.append(self._now())
            candidate = str(submitted_code or "").strip().upper()
            if not secrets.compare_digest(candidate, self.code):
                raise ValueError("Pairing code is incorrect.")
            token = secrets.token_urlsafe(32)
            session = Session(token=token, client_host=client_host, expires_at=self._now() + SESSION_TTL_SECONDS)
            self._sessions[token] = session
            return session

    def authorize(self, client_host: str, token: str | None) -> bool:
        if not is_private_client(client_host) or not token:
            return False
        with self._lock:
            self._cleanup_locked()
            session = self._sessions.get(token)
            return bool(session and session.client_host == client_host and session.expires_at > self._now())

    def revoke(self, token: str | None) -> None:
        if not token:
            return
        with self._lock:
            self._sessions.pop(token, None)
