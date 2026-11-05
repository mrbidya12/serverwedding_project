import base64
from nacl.public import PrivateKey

def main():
    private = PrivateKey.generate()
    public = private.public_key
    print(base64.b64encode(bytes(public)).decode())
    print(base64.b64encode(bytes(private)).decode())

if __name__ == "__main__":
    main()