const io = require('socket.io-client');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const token = process.argv[2];
const privateKey = process.argv[3]?.trim();

if (!token || !privateKey) {
    console.error('❌ Usage: node test-client-decrypt.js <clientToken> <clientPrivateKey>');
    process.exit(1);
}

console.log('🔑 Client private key loaded (length:', privateKey.length, ')');

const socket = io('http://localhost:30000', {
    path: '/api/chat',
    transports: ['websocket'],
    auth: { token }
});

function decryptMessage(ciphertext) {
    try {
        const script = `
import base64
import sys
from nacl.public import SealedBox, PrivateKey

priv_b64 = sys.argv[1].strip()
cipher_b64 = sys.argv[2].strip()
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
    console.log('📩 Client received (ciphertext):', data.content);
    const plaintext = decryptMessage(data.content);
    console.log('🔓 Decrypted message:', plaintext);
});

socket.on('connect', () => {
    console.log('✅ Client listening for encrypted messages...');
});

socket.on('connect_error', (err) => {
    console.error('❌ Connection error:', err.message);
});
