#!/usr/bin/env python3
"""Decrypt a HvostMarket weekly snapshot using your personal private key.
Requirements: pip install cryptography
Usage: python decrypt_backup.py --key HvostMarket_PRIVATE_KEY.txt --input 2026-11-21.json --output hvostmarket.zip
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

AAD = b"hvostmarket-context-backup-v1"

def b64(s):
    return base64.b64decode(s)

def main():
    a = argparse.ArgumentParser()
    a.add_argument('--key', required=True)
    a.add_argument('--input', required=True)
    a.add_argument('--output', required=True)
    opt = a.parse_args()
    secret_obj = json.loads(Path(opt.key).read_text(encoding='utf-8'))
    data = json.loads(Path(opt.input).read_text(encoding='utf-8'))
    if data['format'] != 'hvostmarket-backup-v1':
        raise ValueError('Unsupported format')
    private_key = X25519PrivateKey.from_private_bytes(b64(secret_obj['private_key_b64']))
    sender = X25519PublicKey.from_public_bytes(b64(data['ephemeral_public_key_b64']))
    material = private_key.exchange(sender)
    aes_key = HKDF(algorithm=SHA256(), length=32, salt=b64(data['salt_b64']), info=AAD).derive(material)
    encoded = data.get('ciphertext_b64', '') or ''.join(data['ciphertext_b64_lines'])
    blob = AESGCM(aes_key).decrypt(b64(data['nonce_b64']), b64(encoded), AAD)
    actual = hashlib.sha256(blob).hexdigest()
    if actual != data['plaintext_sha256']:
        raise ValueError('Checksum mismatch')
    Path(opt.output).write_bytes(blob)
    print('Decrypted archive:', opt.output)
    print('SHA-256:', actual)

if __name__ == '__main__':
    main()