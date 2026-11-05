const io = require('socket.io-client');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const token = process.argv[2];
const privateKey = process.argv[3];  // base64 private key

if (!token || !privateKey) {
    console.error('❌ Usage: node test-vendor-decrypt.js <vendorToken> <vendorPrivateKey>');
    process.exit(1);
}

const socket = io('http://localhost:30000', {
    path: '/api/chat',
    transports: ['websocket'],
    auth: { token }
});

// Function to decrypt using Python script
function decryptMessage(ciphertext) {
    try {
        // Write a temporary Python script that takes private key and ciphertext
        const script = `
import base64
import sys
from nacl.public import SealedBox, PrivateKey

priv_b64 = sys.argv[1]
cipher_b64 = sys.argv[2]
priv = PrivateKey(base64.b64decode(priv_b64))
sealed = SealedBox(priv)
plaintext = sealed.decrypt(base64.b64decode(cipher_b64))
print(plaintext.decode())
`;
        const tempFile = path.join(__dirname, '_decrypt_temp.py');
        fs.writeFileSync(tempFile, script);
        const result = execSync(`python ${tempFile} "${privateKey}" "${ciphertext}"`, { encoding: 'utf8' });
        fs.unlinkSync(tempFile);
        return result.trim();
    } catch (err) {
        return `[Decryption failed: ${err.message}]`;
    }
}

socket.on('receive_message', (data) => {
    console.log('📩 Vendor received (ciphertext):', data.content);
    // Try to decrypt
    const plaintext = decryptMessage(data.content);
    console.log('🔓 Decrypted message:', plaintext);
});

socket.on('connect', () => {
    console.log('✅ Vendor listening for encrypted messages...');
    console.log('🔑 Private key loaded (length:', privateKey.length, ')');
});

socket.on('connect_error', (err) => {
    console.error('❌ Connection error:', err.message);
});
