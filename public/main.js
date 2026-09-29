const socket = io();

// UI Elements
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const setupSection = document.getElementById('setup-section');
const transferSection = document.getElementById('transfer-section');
const currentRoomSpan = document.getElementById('current-room');
const statusSpan = document.getElementById('status');
const fileInput = document.getElementById('file-input');
const sendBtn = document.getElementById('send-btn');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const downloadList = document.getElementById('download-list');

function logDebug(msg) {
    console.log(new Date().toLocaleTimeString() + ' - ' + msg);
}

let peerConnection;
let dataChannel;
let remoteSocketId;
let roomId;
let isP2pReady = false;
let isPeerConnected = false;

const CHUNK_SIZE = 65536; // 64KB (Socket.io経由も考慮)

// STUN/TURN
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:openrelay.metered.ca:80' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

// URLパラメータ
window.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam) {
        roomInput.value = roomParam;
        joinRoom(roomParam);
    } else {
        roomInput.value = 'room-' + Math.random().toString(36).substring(2, 8);
    }
});

function joinRoom(id) {
    roomId = id;
    socket.emit('join-room', roomId);
    setupSection.style.display = 'none';
    transferSection.style.display = 'block';
    currentRoomSpan.textContent = roomId;
    
    const joinUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    document.getElementById('qrcode').innerHTML = '';
    new QRCode(document.getElementById('qrcode'), {
        text: joinUrl, width: 128, height: 128, colorDark : "#000000", colorLight : "#ffffff"
    });
    logDebug('ルームに参加しました: ' + roomId);
    updateStatus();
}

joinBtn.addEventListener('click', () => {
    const id = roomInput.value.trim();
    if (id) joinRoom(id);
});

// 通信可能になった時の処理
function setPeerConnected() {
    isPeerConnected = true;
    fileInput.disabled = false;
    sendBtn.disabled = false;
    updateStatus();
}

function updateStatus() {
    if (isP2pReady) {
        statusSpan.textContent = 'P2P 接続完了 (高速転送モード)';
        statusSpan.style.color = '#2ecc71'; // Green
    } else if (isPeerConnected) {
        statusSpan.textContent = 'サーバー経由で接続中 (確実転送モード)';
        statusSpan.style.color = '#f39c12'; // Orange
    } else {
        statusSpan.textContent = '相手の参加を待っています...';
        statusSpan.style.color = '#7f8c8d'; // Neutral Gray instead of Red
    }
}

// -------------------------
// Signaling & WebRTC
// -------------------------
socket.on('user-joined', async (userId) => {
    logDebug('相手が入室しました');
    remoteSocketId = userId;
    setPeerConnected();
    createPeerConnection();
    
    dataChannel = peerConnection.createDataChannel('file-transfer');
    setupDataChannel();

    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal', { to: remoteSocketId, signal: peerConnection.localDescription });
    } catch (err) {
        logDebug('Offer作成エラー: ' + err.message);
    }
});

let iceCandidateQueue = [];
socket.on('signal', async (data) => {
    remoteSocketId = data.from;
    const signal = data.signal;
    logDebug('WebRTCシグナル受信: ' + (signal.type || 'ICE候補'));
    
    setPeerConnected();

    if (!peerConnection) createPeerConnection();

    try {
        if (signal.type === 'offer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('signal', { to: remoteSocketId, signal: peerConnection.localDescription });
            while(iceCandidateQueue.length) await peerConnection.addIceCandidate(iceCandidateQueue.shift());
        } else if (signal.type === 'answer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
            while(iceCandidateQueue.length) await peerConnection.addIceCandidate(iceCandidateQueue.shift());
        } else if (signal.candidate) {
            if (peerConnection.remoteDescription) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(signal));
            } else {
                iceCandidateQueue.push(new RTCIceCandidate(signal));
            }
        }
    } catch (err) {
        logDebug('Signal処理エラー: ' + err.message);
    }
});

function createPeerConnection() {
    peerConnection = new RTCPeerConnection(configuration);
    peerConnection.oniceconnectionstatechange = () => {
        logDebug('WebRTC 状態: ' + peerConnection.iceConnectionState);
        if (peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'disconnected') {
            isP2pReady = false;
            updateStatus();
        }
    };
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) socket.emit('signal', { to: remoteSocketId, signal: event.candidate });
    };
    peerConnection.ondatachannel = (event) => {
        dataChannel = event.channel;
        setupDataChannel();
    };
}

function setupDataChannel() {
    dataChannel.binaryType = 'arraybuffer';
    dataChannel.onopen = () => {
        logDebug('WebRTC P2P接続 成功！');
        isP2pReady = true;
        updateStatus();
    };
    dataChannel.onclose = () => {
        isP2pReady = false;
        updateStatus();
    };
    dataChannel.onmessage = (event) => {
        handleIncomingData(event.data);
    };
}

// -------------------------
// WebSocket (フォールバック) 経由の受信
// -------------------------
socket.on('file-relay', (data) => {
    if (typeof data.payload === 'string') {
        logDebug('サーバー経由で制御データを受信');
    }
    handleIncomingData(data.payload);
});


// -------------------------
// ファイル受信処理（共通）
// -------------------------
let receiveBuffer = [];
let receivedSize = 0;
let incomingFileInfo = null;

function handleIncomingData(data) {
    if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg.type === 'meta') {
            incomingFileInfo = msg;
            receiveBuffer = [];
            receivedSize = 0;
            progressText.textContent = `受信中: ${msg.name} ...`;
            progressBar.style.width = '0%';
        } else if (msg.type === 'eof') {
            const blob = new Blob(receiveBuffer);
            const downloadUrl = URL.createObjectURL(blob);
            const li = document.createElement('li');
            li.innerHTML = `<span>${incomingFileInfo.name} (${(incomingFileInfo.size / 1024 / 1024).toFixed(2)} MB)</span> <a href="${downloadUrl}" download="${incomingFileInfo.name}">ダウンロード</a>`;
            downloadList.appendChild(li);
            progressText.textContent = '受信完了！';
            progressBar.style.width = '100%';
            receiveBuffer = [];
            logDebug('ファイル受信完了');
        }
    } else {
        receiveBuffer.push(data);
        receivedSize += data.byteLength;
        if (incomingFileInfo) {
            const percent = (receivedSize / incomingFileInfo.size) * 100;
            progressBar.style.width = percent + '%';
        }
    }
}

// -------------------------
// ファイル送信処理（複数ファイル対応キュー方式）
// -------------------------
let sendQueue = [];
let isSending = false;

sendBtn.addEventListener('click', () => {
    const files = fileInput.files;
    if (files.length === 0) return;

    // 選択された全ファイルをキューに追加
    for (let i = 0; i < files.length; i++) {
        sendQueue.push(files[i]);
    }
    
    // 入力欄をクリア（次回の選択のため）
    fileInput.value = '';

    // 送信中でなければ送信開始
    if (!isSending) {
        processSendQueue();
    }
});

function processSendQueue() {
    if (sendQueue.length === 0) {
        isSending = false;
        progressText.textContent = 'すべてのファイルの送信が完了しました！';
        return;
    }

    isSending = true;
    const file = sendQueue.shift(); // キューから最初のファイルを取り出す

    progressText.textContent = `送信中: ${file.name} (残り ${sendQueue.length} 個)...`;
    progressBar.style.width = '0%';
    logDebug('ファイル送信開始: ' + file.name);

    const sendData = (payload) => {
        if (isP2pReady && dataChannel && dataChannel.readyState === 'open') {
            dataChannel.send(payload);
        } else {
            socket.emit('file-relay', { roomId: roomId, payload: payload });
        }
    };

    // メタデータの送信
    sendData(JSON.stringify({ type: 'meta', name: file.name, size: file.size }));

    const reader = new FileReader();
    let offset = 0;

    reader.onload = (e) => {
        if (isP2pReady && dataChannel.bufferedAmount > 8 * 1024 * 1024) {
            setTimeout(() => {
                sendData(e.target.result);
                updateProgressAndReadNext();
            }, 50);
            return;
        }

        sendData(e.target.result);
        updateProgressAndReadNext();

        function updateProgressAndReadNext() {
            offset += e.target.result.byteLength;
            const percent = (offset / file.size) * 100;
            progressBar.style.width = percent + '%';

            if (offset < file.size) {
                readSlice(offset);
            } else {
                // ファイル1つ送信完了
                sendData(JSON.stringify({ type: 'eof' }));
                logDebug('ファイル送信完了: ' + file.name);
                
                // 少しだけ待機（受信側の処理時間確保）してから次のファイルを送信
                setTimeout(() => {
                    processSendQueue();
                }, 500);
            }
        }
    };

    const readSlice = (o) => {
        const slice = file.slice(o, o + CHUNK_SIZE);
        reader.readAsArrayBuffer(slice);
    };

    readSlice(0);
}

// 背景アニメーション
tsParticles.load("tsparticles", {
    background: { color: { value: "#f4f7f6" } },
    fpsLimit: 60,
    interactivity: {
        events: { onHover: { enable: true, mode: "grab" } },
        modes: { grab: { distance: 140, links: { opacity: 1 } } }
    },
    particles: {
        color: { value: "#3498db" },
        links: { color: "#2980b9", distance: 150, enable: true, opacity: 0.4, width: 1 },
        move: { direction: "none", enable: true, outModes: { default: "bounce" }, random: false, speed: 1, straight: false },
        number: { density: { enable: true, area: 800 }, value: 80 },
        opacity: { value: 0.5 },
        shape: { type: "circle" },
        size: { value: { min: 1, max: 3 } },
    },
    detectRetina: true,
});
