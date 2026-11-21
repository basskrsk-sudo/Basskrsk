#!/usr/bin/env python3
"""Encrypt a ZIP snapshot to a recipient X25519 public key. No private key required.
Requirements: pip install cryptography
Usage: python encrypt_backup.py --public-key public_key.json --input backup.zip --output 2026-11-28.json
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

AAD = b'hvostmarket-context-backup-v1'


def b64(x):
    return base64.b64encode(x).decode('ascii')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--public-key', required=True)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    p = json.loads(Path(args.public_key).read_text(encoding='utf-8'))
    recipient = X25519PublicKey.from_public_bytes(base64.b64decode(p['public_key_b64']))
    ephemeral = X25519PrivateKey.generate()
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    eph_public = ephemeral.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    salt, nonce = os.urandom(32), os.urandom(12)
    secret = HKDF(algorithm=SHA256(), length=32, salt=salt, info=AAD).derive(ephemeral.exchange(recipient))
    plain = Path(args.input).read_bytes()
    encrypted = AESGCM(secret).encrypt(nonce, plain, AAD)
    ciphertext_b64 = b64(encrypted)
    chunk = 8192
    o = {
        'format': 'hvostmarket-backup-v1',
        'created_at_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
        'payload_filename': Path(args.input).name,
        'plaintext_sha256': hashlib.sha256(plain).hexdigest(),
        'public_key_fingerprint': p['public_key_fingerprint'],
        'ephemeral_public_key_b64': b64(eph_public),
        'salt_b64': b64(salt),
        'nonce_b64': b64(nonce),
        'ciphertext_b64_lines': [ciphertext_b64[i:i+chunk] for i in range(0, len(ciphertext_b64), chunk)]
    }
    Path(args.output).write_text(json.dumps(o, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('Encrypted:', args.output, 'bytes:', len(encrypted))

if __name__ == '__main__':
    main()