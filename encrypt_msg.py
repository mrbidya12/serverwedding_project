import base64
from nacl.public import SealedBox, PublicKey

recipient_pub_b64 = input()
plaintext = input()
recipient_pub = PublicKey(base64.b64decode(recipient_pub_b64))
sealed = SealedBox(recipient_pub)
ciphertext = sealed.encrypt(plaintext.encode())
print(base64.b64encode(ciphertext).decode())
