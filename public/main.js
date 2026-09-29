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

// デバッグ用ログ表示
const debugLog = document.createElement('div');
debugLog.style.cssText = 'margin-top:20px; padding:10px; background:#f8d7da; color:#721c24; font-size:12px; height:100px; overflow-y:auto; border-radius:4px;';
document.querySelector('.container').appendChild(debugLog);
function logDebug(msg) {
    console.log(msg);
    debugLog.innerHTML += `<div>${new Date().toLocaleTimeString()} - ${msg}</div>`;
    debugLog.scrollTop = debugLog.scrollHeight;
}

let peerConnection;
let dataChannel;
let remoteSocketId;
let roomId;

const CHUNK_SIZE = 16384; // 16KB

// STUN/TURNサーバー設定（NAT越えを強力にするために無料のTURNを追加）
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:openrelay.metered.ca:80' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

// URLパラメータのチェックと初期化
window.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    
    if (roomParam) {
        roomInput.value = roomParam;
        joinRoom(roomParam);
    } else {
        // ランダムなルームIDを生成
        roomInput.value = 'room-' + Math.random().toString(36).substring(2, 8);
    }
});

function joinRoom(id) {
    roomId = id;
    socket.emit('join-room', roomId);
    setupSection.style.display = 'none';
    transferSection.style.display = 'block';
    currentRoomSpan.textContent = roomId;
    
    // QRコードの生成 (スマホからのアクセス用)
    const joinUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    document.getElementById('qrcode').innerHTML = '';
    new QRCode(document.getElementById('qrcode'), {
        text: joinUrl,
        width: 128,
        height: 128,
        colorDark : "#000000",
        colorLight : "#ffffff"
    });
}

// ルームに参加
joinBtn.addEventListener('click', () => {
    const id = roomInput.value.trim();
    if (id) {
        joinRoom(id);
    }
});

// 他のユーザーが参加した時の処理（Offer側になる）
socket.on('user-joined', async (userId) => {
    logDebug('Other user joined: ' + userId);
    remoteSocketId = userId;
    createPeerConnection();
    
    // DataChannelの作成（Offer側が作成する）
    dataChannel = peerConnection.createDataChannel('file-transfer');
    setupDataChannel();

    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal', { to: remoteSocketId, signal: peerConnection.localDescription });
        logDebug('Sent Offer to ' + remoteSocketId);
    } catch (err) {
        logDebug('Error creating offer: ' + err.message);
    }
});

let iceCandidateQueue = [];

// シグナリングメッセージの受信
socket.on('signal', async (data) => {
    remoteSocketId = data.from;
    const signal = data.signal;
    logDebug('Received signal: ' + (signal.type || 'candidate'));

    if (!peerConnection) {
        createPeerConnection();
    }

    try {
        if (signal.type === 'offer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('signal', { to: remoteSocketId, signal: peerConnection.localDescription });
            logDebug('Sent Answer to ' + remoteSocketId);
            
            // バッファされたCandidateを追加
            while(iceCandidateQueue.length) {
                await peerConnection.addIceCandidate(iceCandidateQueue.shift());
            }
        } else if (signal.type === 'answer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
            logDebug('Set Remote Answer');
            
            // バッファされたCandidateを追加
            while(iceCandidateQueue.length) {
                await peerConnection.addIceCandidate(iceCandidateQueue.shift());
            }
        } else if (signal.candidate) {
            if (peerConnection.remoteDescription) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(signal));
                logDebug('Added ICE Candidate');
            } else {
                iceCandidateQueue.push(new RTCIceCandidate(signal));
                logDebug('Queued ICE Candidate');
            }
        }
    } catch (err) {
        logDebug('Error handling signal: ' + err.message);
    }
});

function createPeerConnection() {
    peerConnection = new RTCPeerConnection(configuration);
    logDebug('Created RTCPeerConnection');

    peerConnection.oniceconnectionstatechange = () => {
        logDebug('ICE State: ' + peerConnection.iceConnectionState);
        if (peerConnection.iceConnectionState === 'failed') {
            statusSpan.textContent = '接続失敗 (ネットワーク制限)';
            statusSpan.style.color = 'red';
        }
    };

    // ICE Candidateの送信
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', { to: remoteSocketId, signal: event.candidate });
        }
    };

    // DataChannelの受信（Answer側）
    peerConnection.ondatachannel = (event) => {
        logDebug('Received DataChannel');
        dataChannel = event.channel;
        setupDataChannel();
    };
}

// 受信用の状態変数
let receiveBuffer = [];
let receivedSize = 0;
let incomingFileInfo = null;

function setupDataChannel() {
    dataChannel.binaryType = 'arraybuffer';

    dataChannel.onopen = () => {
        logDebug('DataChannel is open');
        statusSpan.textContent = '接続完了！ファイルを送信できます';
        statusSpan.style.color = '#2ecc71';
        fileInput.disabled = false;
        sendBtn.disabled = false;
    };

    dataChannel.onclose = () => {
        logDebug('DataChannel is closed');
        statusSpan.textContent = '切断されました';
        statusSpan.style.color = '#e74c3c';
        fileInput.disabled = true;
        sendBtn.disabled = true;
    };

    dataChannel.onmessage = (event) => {
        if (typeof event.data === 'string') {
            // メタデータまたは完了通知
            const msg = JSON.parse(event.data);
            if (msg.type === 'meta') {
                incomingFileInfo = msg;
                receiveBuffer = [];
                receivedSize = 0;
                progressText.textContent = `受信中: ${msg.name} ...`;
                progressBar.style.width = '0%';
            } else if (msg.type === 'eof') {
                // ファイル受信完了
                const blob = new Blob(receiveBuffer);
                const downloadUrl = URL.createObjectURL(blob);
                
                const li = document.createElement('li');
                li.innerHTML = `<span>${incomingFileInfo.name} (${(incomingFileInfo.size / 1024 / 1024).toFixed(2)} MB)</span> <a href="${downloadUrl}" download="${incomingFileInfo.name}">ダウンロード</a>`;
                downloadList.appendChild(li);

                progressText.textContent = '受信完了！';
                progressBar.style.width = '100%';
                receiveBuffer = [];
            }
        } else {
            // バイナリデータ（チャンク）の受信
            receiveBuffer.push(event.data);
            receivedSize += event.data.byteLength;
            
            // 進捗の更新
            if (incomingFileInfo) {
                const percent = (receivedSize / incomingFileInfo.size) * 100;
                progressBar.style.width = percent + '%';
            }
        }
    };
}

// ファイル送信処理
sendBtn.addEventListener('click', () => {
    const file = fileInput.files[0];
    if (!file) return;

    // メタデータの送信
    dataChannel.send(JSON.stringify({
        type: 'meta',
        name: file.name,
        size: file.size
    }));

    progressText.textContent = `送信中: ${file.name} ...`;
    progressBar.style.width = '0%';

    // ファイルの読み込みとチャンク送信
    const reader = new FileReader();
    let offset = 0;

    reader.onload = (e) => {
        // バッファリングを防ぐため、送信が詰まっていないか確認
        if (dataChannel.bufferedAmount > 16 * 1024 * 1024) {
            // バッファが16MBを超えたら少し待機
            setTimeout(() => {
                dataChannel.send(e.target.result);
                updateProgressAndReadNext();
            }, 50);
            return;
        }

        dataChannel.send(e.target.result);
        updateProgressAndReadNext();

        function updateProgressAndReadNext() {
            offset += e.target.result.byteLength;
            
            const percent = (offset / file.size) * 100;
            progressBar.style.width = percent + '%';

            if (offset < file.size) {
                readSlice(offset);
            } else {
                // 全て送信完了
                dataChannel.send(JSON.stringify({ type: 'eof' }));
                progressText.textContent = '送信完了！';
                fileInput.value = '';
            }
        }
    };

    const readSlice = (o) => {
        const slice = file.slice(o, o + CHUNK_SIZE);
        reader.readAsArrayBuffer(slice);
    };

    readSlice(0);
});

// ネットワーク背景のアニメーション (tsParticles)
tsParticles.load("tsparticles", {
    background: {
        color: {
            value: "#f4f7f6",
        },
    },
    fpsLimit: 60,
    interactivity: {
        events: {
            onHover: {
                enable: true,
                mode: "grab",
            },
        },
        modes: {
            grab: {
                distance: 140,
                links: {
                    opacity: 1
                }
            }
        }
    },
    particles: {
        color: {
            value: "#3498db",
        },
        links: {
            color: "#2980b9",
            distance: 150,
            enable: true,
            opacity: 0.4,
            width: 1,
        },
        move: {
            direction: "none",
            enable: true,
            outModes: {
                default: "bounce",
            },
            random: false,
            speed: 1,
            straight: false,
        },
        number: {
            density: {
                enable: true,
                area: 800,
            },
            value: 80,
        },
        opacity: {
            value: 0.5,
        },
        shape: {
            type: "circle",
        },
        size: {
            value: { min: 1, max: 3 },
        },
    },
    detectRetina: true,
});
