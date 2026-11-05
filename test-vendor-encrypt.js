const io = require('socket.io-client');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const token = process.argv[2];
const toUserId = process.argv[3];
const recipientPublicKey = process.argv[4]?.trim();
const plaintext = process.argv[5] || 'Hello from vendor!';

if (!token || !toUserId || !recipientPublicKey) {
    console.error('❌ Usage: node test-vendor-encrypt.js <vendorToken> <toUserId> <clientPublicKey> [plaintext]');
    process.exit(1);
}

function encryptMessage(publicKey, message) {
    try {
        const script = `
import base64
import sys
from nacl.public import SealedBox, PublicKey

pub_b64 = sys.argv[1].strip()
msg = sys.argv[2]
pub = PublicKey(base64.b64decode(pub_b64))
sealed = SealedBox(pub)
cipher = sealed.encrypt(msg.encode())
print(base64.b64encode(cipher).decode())
`;
        const tempFile = path.join(__dirname, '_encrypt_temp.py');
        fs.writeFileSync(tempFile, script);
        const result = execSync(`python ${tempFile} "${publicKey}" "${message}"`, { encoding: 'utf8' });
        fs.unlinkSync(tempFile);
        return result.trim();
    } catch (err) {
        console.error('❌ Encryption failed:', err.message);
        process.exit(1);
    }
}

const ciphertext = encryptMessage(recipientPublicKey, plaintext);
console.log('🔐 Ciphertext:', ciphertext);

const socket = io('http://localhost:30000', {
    path: '/api/chat',
    transports: ['websocket'],
    auth: { token }
});

socket.on('connect', () => {
    console.log('✅ Connected to chat-service!');
    socket.emit('send_message', { toUserId, content: ciphertext, type: 'text' });
});

socket.on('message_sent', (data) => {
    console.log('📤 Message sent (encrypted)');
    socket.disconnect();
    process.exit(0);
});

socket.on('error', (err) => {
    console.error('❌ Error:', err);
    socket.disconnect();
    process.exit(1);
});

socket.on('connect_error', (err) => {
    console.error('❌ Connection error:', err.message);
    process.exit(1);
});
