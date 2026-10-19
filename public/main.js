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
const progressArea = document.getElementById('progress-area');
const progressTitle = document.getElementById('progress-title');
const progressFilename = document.getElementById('progress-filename');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const progressPercent = document.getElementById('progress-percent');
const cancelBtn = document.getElementById('cancel-btn');
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
    // バッファ下限しきい値を256KBに設定
    dataChannel.bufferedAmountLowThreshold = 256 * 1024;
    dataChannel.onopen = () => {
        logDebug('WebRTC P2P接続 成功！');
        isP2pReady = true;
        updateStatus();
    };
    dataChannel.onclose = () => {
        isP2pReady = false;
        updateStatus();
    };
    dataChannel.onerror = (err) => {
        logDebug('DataChannel エラー: ' + err);
    };
    dataChannel.onmessage = (event) => {
        handleIncomingData(event.data);
    };
}

// 再接続時に自動でルームへ再参加する
socket.on('connect', () => {
    if (roomId) {
        socket.emit('join-room', roomId);
    }
});

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
// ファイル受信・送信のダイアログUI制御
// -------------------------
let receiveBuffer = [];
let receivedSize = 0;
let incomingFileInfo = null;
let lastReceiveUiUpdate = 0;
let isTransferCanceled = false;

function formatMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1);
}

function showProgressDialog(modeTitle, fileName, currentBytes, totalBytes) {
    progressArea.style.display = 'block';
    progressTitle.textContent = modeTitle;
    progressFilename.textContent = fileName;
    updateProgressDialog(currentBytes, totalBytes, modeTitle);
}

function updateProgressDialog(currentBytes, totalBytes, labelPrefix) {
    const percent = totalBytes > 0 ? Math.min(100, (currentBytes / totalBytes) * 100) : 0;
    progressBar.style.width = percent.toFixed(1) + '%';
    progressPercent.textContent = `${Math.floor(percent)}%`;
    progressText.textContent = `${labelPrefix} ${formatMB(currentBytes)} MB / ${formatMB(totalBytes)} MB - ${percent.toFixed(1)}% 完了`;
}

function hideProgressDialog() {
    progressArea.style.display = 'none';
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
}

cancelBtn.addEventListener('click', () => {
    isTransferCanceled = true;
    sendQueue = [];
    receiveBuffer = [];
    incomingFileInfo = null;
    hideProgressDialog();
    // 相手側にもキャンセルを通知
    const cancelMsg = JSON.stringify({ type: 'cancel' });
    if (isP2pReady && dataChannel && dataChannel.readyState === 'open') {
        try { dataChannel.send(cancelMsg); } catch (e) {}
    } else if (roomId) {
        socket.emit('file-relay', { roomId: roomId, payload: cancelMsg });
    }
});

function handleIncomingData(data) {
    if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg.type === 'meta') {
            isTransferCanceled = false;
            incomingFileInfo = msg;
            receiveBuffer = [];
            receivedSize = 0;
            lastReceiveUiUpdate = 0;
            showProgressDialog('📥 受信中...', msg.name, 0, msg.size);
        } else if (msg.type === 'cancel') {
            incomingFileInfo = null;
            receiveBuffer = [];
            receivedSize = 0;
            hideProgressDialog();
        } else if (msg.type === 'eof') {
            if (!incomingFileInfo) return;
            const finishedFile = incomingFileInfo;
            const chunks = receiveBuffer;
            incomingFileInfo = null;
            receiveBuffer = [];
            const blob = new Blob(chunks, { type: finishedFile.mime || 'application/octet-stream' });
            const downloadUrl = URL.createObjectURL(blob);
            const li = document.createElement('li');
            li.innerHTML = `<span>${finishedFile.name} (${formatMB(finishedFile.size)} MB)</span> <a href="${downloadUrl}" download="${finishedFile.name}">ダウンロード</a>`;
            downloadList.appendChild(li);
            hideProgressDialog();
            logDebug('ファイル受信完了');
        }
    } else {
        if (!incomingFileInfo || isTransferCanceled) return;
        receiveBuffer.push(data);
        const chunkLen = data.byteLength || data.length || 0;
        receivedSize += chunkLen;
        if (incomingFileInfo.size > 0) {
            const now = Date.now();
            // 画面更新の負荷を下げるため80msごと、または完了時に表示更新
            if (now - lastReceiveUiUpdate > 80 || receivedSize >= incomingFileInfo.size) {
                lastReceiveUiUpdate = now;
                updateProgressDialog(receivedSize, incomingFileInfo.size, '受信中...');
            }
        }
    }
}

// -------------------------
// ファイル送信処理（複数ファイル・大容量バックプレッシャー対応）
// -------------------------
let sendQueue = [];
let isSending = false;
const MAX_P2P_BUFFER = 1024 * 1024; // 1MBを超えたら送信を一時待機（ブラウザのバッファパンク防止）

sendBtn.addEventListener('click', () => {
    const files = fileInput.files;
    if (files.length === 0) return;

    isTransferCanceled = false;

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

// WebRTCの送信バッファが空くまで確実に待機する関数
function waitForP2pBufferDrain() {
    return new Promise((resolve) => {
        if (!dataChannel || dataChannel.readyState !== 'open' || dataChannel.bufferedAmount <= MAX_P2P_BUFFER) {
            resolve();
            return;
        }
        let resolved = false;
        const done = () => {
            if (resolved) return;
            resolved = true;
            dataChannel.onbufferedamountlow = null;
            clearInterval(timer);
            resolve();
        };
        dataChannel.onbufferedamountlow = done;
        const timer = setInterval(() => {
            if (!dataChannel || dataChannel.readyState !== 'open' || dataChannel.bufferedAmount <= MAX_P2P_BUFFER) {
                done();
            }
        }, 20);
    });
}

// 1チャンクを安全に送信する関数（P2Pバッファ制御＆サーバー中継ACK制御）
async function sendPayloadSafely(payload) {
    if (isP2pReady && dataChannel && dataChannel.readyState === 'open') {
        while (dataChannel.readyState === 'open' && dataChannel.bufferedAmount > MAX_P2P_BUFFER) {
            await waitForP2pBufferDrain();
        }
        dataChannel.send(payload);
    } else {
        await new Promise((resolve) => {
            socket.emit('file-relay', { roomId: roomId, payload: payload }, () => {
                resolve();
            });
            // 万一サーバーからACKが返らない場合のタイムアウト保険
            setTimeout(resolve, 3000);
        });
    }
}

async function processSendQueue() {
    if (isTransferCanceled) {
        isSending = false;
        hideProgressDialog();
        return;
    }
    if (sendQueue.length === 0) {
        isSending = false;
        hideProgressDialog();
        return;
    }

    isSending = true;
    const file = sendQueue.shift(); // キューから最初のファイルを取り出す
    const remainText = sendQueue.length > 0 ? ` (残り ${sendQueue.length} 個)` : '';

    showProgressDialog(`📤 送信中...${remainText}`, file.name, 0, file.size);
    logDebug('ファイル送信開始: ' + file.name);

    try {
        // メタデータの送信
        await sendPayloadSafely(JSON.stringify({
            type: 'meta',
            name: file.name,
            size: file.size,
            mime: file.type || 'application/octet-stream'
        }));

        let offset = 0;
        let lastSendUiUpdate = 0;

        while (offset < file.size) {
            if (isTransferCanceled) {
                isSending = false;
                hideProgressDialog();
                return;
            }
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            const buffer = await slice.arrayBuffer();

            await sendPayloadSafely(buffer);

            offset += buffer.byteLength;
            const now = Date.now();
            if (now - lastSendUiUpdate > 80 || offset >= file.size) {
                lastSendUiUpdate = now;
                updateProgressDialog(offset, file.size, '送信中...');
            }
        }

        // 送信完了前にP2Pバッファが完全に空になるのを待つ
        if (isP2pReady && dataChannel && dataChannel.readyState === 'open') {
            while (dataChannel.readyState === 'open' && dataChannel.bufferedAmount > 0) {
                if (isTransferCanceled) break;
                await new Promise(r => setTimeout(r, 50));
            }
        }

        if (!isTransferCanceled) {
            // ファイル1つ送信完了通知
            await sendPayloadSafely(JSON.stringify({ type: 'eof' }));
            logDebug('ファイル送信完了: ' + file.name);
        }
    } catch (err) {
        logDebug('ファイル送信エラー: ' + err.message);
        progressTitle.textContent = '⚠️ 送信エラー';
        progressText.textContent = `エラー: ${err.message}`;
        return;
    }

    if (sendQueue.length === 0) {
        isSending = false;
        hideProgressDialog();
    } else {
        // 次のファイルがある場合は少しだけ待機してから送信
        setTimeout(() => {
            processSendQueue();
        }, 300);
    }
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
