const io = require('socket.io-client');
const readline = require('readline');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ================================================================
// 1. Parse arguments
// ================================================================
const token = process.argv[2];
const privateKey = process.argv[3]?.trim();
const recipientUserId = process.argv[4];
const recipientPublicKey = process.argv[5]?.trim();

if (!token || !privateKey || !recipientUserId || !recipientPublicKey) {
    console.error('❌ Usage: node chat.js <token> <privateKey> <recipientUserId> <recipientPublicKey>');
    process.exit(1);
}

console.log('🔑 Private key loaded (length:', privateKey.length, ')');
console.log('👤 Recipient ID:', recipientUserId);
console.log('📨 Type your messages below. Press Enter to send.');

// ================================================================
// 2. Crypto helpers (encrypt / decrypt)
// ================================================================
function encryptMessage(publicKey, plaintext) {
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
        const result = execSync(`python ${tempFile} "${publicKey}" "${plaintext}"`, { encoding: 'utf8' });
        fs.unlinkSync(tempFile);
        return result.trim();
    } catch (err) {
        console.error('❌ Encryption error:', err.message);
        return null;
    }
}

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

// ================================================================
// 3. Socket.IO connection
// ================================================================
const socket = io('http://localhost:4000', {
    path: '/api/chat',
    transports: ['websocket'],
    extraHeaders: {
        Authorization: 'Bearer ' + token
    }
});

socket.on('connect', () => {
    console.log('✅ Connected to chat-service!');
});

socket.on('receive_message', (data) => {
    console.log('\n📩 Received (ciphertext):', data.content);
    const plaintext = decryptMessage(data.content);
    console.log('🔓 Decrypted:', plaintext);
    rl.prompt();
});

socket.on('connect_error', (err) => {
    console.error('❌ Connection error:', err.message);
    process.exit(1);
});

// ================================================================
// 4. Readline for user input
// ================================================================
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '✏️  > '
});

rl.prompt();

rl.on('line', (line) => {
    const input = line.trim();
    if (!input) {
        rl.prompt();
        return;
    }

    const ciphertext = encryptMessage(recipientPublicKey, input);
    if (!ciphertext) {
        console.log('❌ Failed to encrypt message');
        rl.prompt();
        return;
    }

    socket.emit('send_message', {
        toUserId: recipientUserId,
        content: ciphertext,
        type: 'text'
    });

    console.log('📤 Message sent (encrypted)');
    rl.prompt();
});

rl.on('close', () => {
    socket.disconnect();
    console.log('👋 Disconnected');
    process.exit(0);
});
