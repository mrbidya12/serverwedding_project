from nacl.public import PrivateKey
import base64

private = PrivateKey.generate()
public = private.public_key
print("Public:", base64.b64encode(bytes(public)).decode())
print("Private:", base64.b64encode(bytes(private)).decode())
