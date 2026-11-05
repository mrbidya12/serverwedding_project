import base64
from nacl.public import SealedBox, PrivateKey

priv_b64 = input()
cipher_b64 = input()
priv = PrivateKey(base64.b64decode(priv_b64))
sealed = SealedBox(priv)
plaintext = sealed.decrypt(base64.b64decode(cipher_b64))
print(plaintext.decode())
