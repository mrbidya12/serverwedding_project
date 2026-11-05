import sys
import base64
import binascii
from nacl.public import SealedBox, PublicKey
from nacl.exceptions import CryptoError

def main():
    # Read raw bytes and decode as UTF-8 explicitly (no silent fallback)
    try:
        data_bytes = sys.stdin.buffer.read()
        data = data_bytes.decode('utf-8')
    except UnicodeDecodeError as e:
        print(f"Error: input is not valid UTF-8: {e}", file=sys.stderr)
        sys.exit(1)

    if '\n' not in data:
        print("Error: need public key (first line) and plaintext (rest)", file=sys.stderr)
        sys.exit(1)

    first_newline = data.index('\n')

    # Strip whitespace FIRST, then remove UTF-8 BOM if present
    pub_raw = data[:first_newline].strip().lstrip('\ufeff')
    plaintext = data[first_newline + 1:]   # preserve everything after the first newline

    if not pub_raw:
        print("Error: public key cannot be empty", file=sys.stderr)
        sys.exit(1)

    # Validate and handle Base64 padding safely
    pad_len = len(pub_raw) % 4
    if pad_len == 1:
        print("Error: Invalid Base64 string length", file=sys.stderr)
        sys.exit(1)
    elif pad_len > 1:
        pub_raw += '=' * (4 - pad_len)

    try:
        pub_bytes = base64.b64decode(pub_raw, validate=True)
        if len(pub_bytes) != 32:
            raise ValueError(f"Public key must decode to exactly 32 bytes (got {len(pub_bytes)})")

        pub_key = PublicKey(pub_bytes)
        sealed_box = SealedBox(pub_key)
        ciphertext = sealed_box.encrypt(plaintext.encode('utf-8'))

        # Write raw Base64 without trailing newline (for pipeline safety)
        sys.stdout.write(base64.b64encode(ciphertext).decode('utf-8'))

    except (ValueError, TypeError, CryptoError, binascii.Error) as e:
        print(f"Encryption failed: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()