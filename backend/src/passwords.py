"""Password hashing for accounts: PBKDF2-HMAC-SHA256 with a random 16-byte salt.

Under the Workers runtime the key derivation runs in WebCrypto (`crypto.subtle`, native code)
through the Pyodide FFI: a pure-Python PBKDF2 would take seconds of CPU time per login, and
Pyodide's hashlib may come without OpenSSL. WebCrypto in Workers allows at most 100 000
iterations, hence ITERATIONS. Outside Workers (pytest under CPython) hashlib does the same
computation, so both give the same hash for the same input.

Stored format: "pbkdf2-sha256$<iterations>$<salt hex>$<hash hex>". The iteration count is part of
the string, so it can be raised later without breaking existing hashes.
"""

import hashlib
import hmac
import secrets

ITERATIONS = 100_000
_SCHEME = "pbkdf2-sha256"


async def _derive(password: str, salt: bytes, iterations: int) -> bytes:
    try:
        from js import Object, Uint8Array, crypto  # type: ignore[import-not-found]
        from pyodide.ffi import to_js  # type: ignore[import-not-found]
    except ImportError:  # CPython (tests): same algorithm, same result
        return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    key = await crypto.subtle.importKey(
        "raw", to_js(password.encode()), "PBKDF2", False, to_js(["deriveBits"])
    )
    params = to_js(
        {"name": "PBKDF2", "hash": "SHA-256", "salt": to_js(salt), "iterations": iterations},
        dict_converter=Object.fromEntries,
    )
    bits = await crypto.subtle.deriveBits(params, key, 256)
    return bytes(Uint8Array.new(bits).to_py())


async def hash_password(password: str, iterations: int = ITERATIONS) -> str:
    salt = secrets.token_bytes(16)
    digest = await _derive(password, salt, iterations)
    return f"{_SCHEME}${iterations}${salt.hex()}${digest.hex()}"


async def verify_password(password: str, stored: str) -> bool:
    """True if `password` matches `stored`. A malformed `stored` is never a match."""
    try:
        scheme, iterations, salt, expected = stored.split("$")
        if scheme != _SCHEME:
            return False
        digest = await _derive(password, bytes.fromhex(salt), int(iterations))
    except ValueError:
        return False
    return hmac.compare_digest(digest.hex(), expected)


# A hash to check against when the username does not exist, so a wrong username takes as long
# as a wrong password (no timing hint about which usernames exist). Made on first use.
_dummy: str | None = None


async def burn_time(password: str) -> None:
    global _dummy
    if _dummy is None:
        _dummy = await hash_password("not a real password")
    await verify_password(password, _dummy)
