import base64
from nacl.public import SealedBox, PrivateKey, PublicKey

client_pub_b64 = "sogjGQ2MRAotqAuwqd/2W6y/kUuzJek+obkrnMs4cGo="
client_priv_b64 = "6Lc+N7AD/jDdL5+GVfRensUnGU+lnVyqIskTz2aLIQw="
vendor_pub_b64 = "PY8qsZaHUFqp5U83fP0C2JAy4ui3cp7VLIkbNNYU1gE="
vendor_priv_b64 = "3RvpSnHEqO8D14abg7rl3tpQxihVPJ8HmuhGWLoUckE="

# Test: Client encrypts with vendor's public key
plaintext = "Test message"
vendor_pub = PublicKey(base64.b64decode(vendor_pub_b64))
sealed = SealedBox(vendor_pub)
ciphertext = sealed.encrypt(plaintext.encode())
ciphertext_b64 = base64.b64encode(ciphertext).decode()
print("Ciphertext:", ciphertext_b64)

# Test: Vendor decrypts with their private key
vendor_priv = PrivateKey(base64.b64decode(vendor_priv_b64))
sealed = SealedBox(vendor_priv)
decrypted = sealed.decrypt(base64.b64decode(ciphertext_b64))
print("Decrypted:", decrypted.decode())
