const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Socket.ioのバッファサイズ設定（大きなファイルのチャンクを中継するため）
const io = new Server(server, {
    maxHttpBufferSize: 1e8 // 約100MBまで許容
});

// 静的ファイルの提供
app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // ルームへの参加
    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        console.log(`User ${socket.id} joined room ${roomId}`);
        // 部屋の他のメンバーに通知
        socket.to(roomId).emit('user-joined', socket.id);
    });

    // WebRTCシグナリングメッセージの中継
    socket.on('signal', (data) => {
        io.to(data.to).emit('signal', {
            from: socket.id,
            signal: data.signal
        });
    });

    // P2Pがブロックされた場合の、Socket.IO経由でのファイルデータ中継
    socket.on('file-relay', (data) => {
        socket.to(data.roomId).emit('file-relay', data);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
