const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// 靜態檔案
app.use(express.static('public'));

// 房間資料結構
const rooms = {};

// 房間管理類
class Room {
    constructor(name) {
        this.name = name;
        this.participants = [];
        this.phase = 'lobby'; // lobby, input, revealed
        this.submissions = {};
        this.frozenOrder = [];
        this.result = null;
        this.winner = null;
    }

    addParticipant(userName, socketId) {
        // 檢查是否已存在
        const existing = this.participants.find(p => p.name === userName);
        if (existing) {
            existing.socketId = socketId;
            existing.online = true;
            return false; // 重新連線
        }

        // 新加入
        const isHost = this.participants.length === 0;
        this.participants.push({
            name: userName,
            socketId: socketId,
            isHost: isHost,
            online: true,
            joinTime: Date.now()
        });
        return true;
    }

    removeParticipant(socketId) {
        const participant = this.participants.find(p => p.socketId === socketId);
        if (participant) {
            participant.online = false;
            this.checkAndTransferHost();
        }
    }

    kickParticipant(userName) {
        const index = this.participants.findIndex(p => p.name === userName);
        if (index !== -1) {
            const kicked = this.participants[index];
            this.participants.splice(index, 1);
            this.checkAndTransferHost();
            return kicked.socketId;
        }
        return null;
    }

    checkAndTransferHost() {
        const currentHost = this.participants.find(p => p.isHost);
        
        // 如果當前主持人離線或不存在
        if (!currentHost || !currentHost.online) {
            // 清除原主持人標記
            this.participants.forEach(p => p.isHost = false);
            
            // 找在線的最早加入者
            const onlineParticipants = this.participants.filter(p => p.online);
            if (onlineParticipants.length > 0) {
                onlineParticipants.sort((a, b) => a.joinTime - b.joinTime);
                onlineParticipants[0].isHost = true;
            } else if (this.participants.length > 0) {
                // 如果都離線，給最早加入者
                this.participants.sort((a, b) => a.joinTime - b.joinTime);
                this.participants[0].isHost = true;
            }
        }
    }

    startRound() {
        if (this.phase !== 'lobby' || this.participants.length < 2) {
            return false;
        }
        
        this.phase = 'input';
        this.submissions = {};
        this.frozenOrder = [...this.participants];
        this.result = null;
        this.winner = null;
        return true;
    }

    submitNumber(userName, number) {
    if (this.phase !== 'input') {
        return false;
    }
    
    // 確認是凍結名單中的人
    if (!this.frozenOrder.find(p => p.name === userName)) {
        return false;
    }
    
    // 驗證數字範圍 (1 到 n)
    const n = this.frozenOrder.length;
    if (number < 1 || number > n) {
        return false;
    }
    
    this.submissions[userName] = number;
    return true;
}

    canReveal() {
        const totalParticipants = this.frozenOrder.length;
        const submittedCount = Object.keys(this.submissions).length;
        return submittedCount === totalParticipants;
    }

    reveal(force = false) {
        if (this.phase !== 'input') {
            return false;
        }

        // 強制揭曉：未提交者視為0
        if (force) {
            this.frozenOrder.forEach(p => {
                if (!(p.name in this.submissions)) {
                    this.submissions[p.name] = 1;
                }
            });
        } else if (!this.canReveal()) {
            return false;
        }

        // 計算結果
    let total = 0;
    for (const value of Object.values(this.submissions)) {
        total += value;
    }

    const n = this.frozenOrder.length;
    const remainder = total % n;
    
    // 新的對應規則：
    // 餘數 0 → 最後一位 (index = n-1)
    // 餘數 1 → 第一位 (index = 0)
    // 餘數 2 → 第二位 (index = 1)
    // ...以此類推
    const winnerIndex = remainder === 0 ? n - 1 : remainder - 1;
    
    this.winner = this.frozenOrder[winnerIndex].name;
    this.result = {
        total: total,
        participantCount: n,
        index: remainder,  // 儲存餘數而非實際索引
        actualWinnerIndex: winnerIndex,  // 實際的陣列索引
        submissions: { ...this.submissions }
    };
    
    this.phase = 'revealed';
    return true;
}

    backToLobby() {
        this.phase = 'lobby';
        this.submissions = {};
        this.frozenOrder = [];
        this.result = null;
        this.winner = null;
        return true;
    }

    getState() {
        return {
            name: this.name,
            participants: this.participants.map(p => ({
                name: p.name,
                isHost: p.isHost,
                online: p.online
            })),
            phase: this.phase,
            submissions: this.phase === 'input' ? 
                Object.keys(this.submissions).reduce((acc, key) => {
                    acc[key] = true; // 只顯示是否已提交
                    return acc;
                }, {}) : null,
            result: this.result,
            winner: this.winner
        };
    }

    isEmpty() {
        return this.participants.filter(p => p.online).length === 0;
    }
}

// Socket.IO 處理
io.on('connection', (socket) => {
    let currentRoom = null;
    let currentUser = null;

    socket.on('joinRoom', (data) => {
        const { roomName, userName } = data;

        // 驗證輸入
        if (!roomName || !userName) {
            socket.emit('joinError', '房間名稱和名字不能為空');
            return;
        }

        // 建立或取得房間
        if (!rooms[roomName]) {
            rooms[roomName] = new Room(roomName);
        }

        const room = rooms[roomName];

        // 檢查是否可以加入
        if (room.phase !== 'lobby') {
            // 檢查是否為重新連線
            const existing = room.participants.find(p => p.name === userName);
            if (!existing) {
                socket.emit('joinError', '回合進行中，無法加入');
                return;
            }
        }

        // 加入房間
        const isNewUser = room.addParticipant(userName, socket.id);
        
        currentRoom = roomName;
        currentUser = userName;
        socket.join(roomName);

        // 通知成功
        const participant = room.participants.find(p => p.name === userName);
        socket.emit('joinSuccess', {
            roomName: roomName,
            userName: userName,
            isHost: participant.isHost,
            roomState: room.getState()
        });

        // 通知其他人
        if (isNewUser) {
            socket.to(roomName).emit('roomUpdate', room.getState());
        } else {
            io.to(roomName).emit('roomUpdate', room.getState());
        }
    });

    socket.on('startRound', () => {
        if (!currentRoom || !currentUser) return;
        
        const room = rooms[currentRoom];
        if (!room) return;

        const participant = room.participants.find(p => p.name === currentUser);
        if (!participant || !participant.isHost) {
            socket.emit('error', '只有主持人可以開始回合');
            return;
        }

        if (room.startRound()) {
            io.to(currentRoom).emit('roomUpdate', room.getState());
        } else {
            socket.emit('error', '無法開始回合');
        }
    });

    socket.on('submitNumber', (number) => {
        if (!currentRoom || !currentUser) return;
        
        const room = rooms[currentRoom];
        if (!room) return;

        if (room.submitNumber(currentUser, number)) {
            socket.emit('numberSubmitted');
            io.to(currentRoom).emit('roomUpdate', room.getState());
        } else {
            socket.emit('error', '提交失敗');
        }
    });

    socket.on('revealResult', () => {
        if (!currentRoom || !currentUser) return;
        
        const room = rooms[currentRoom];
        if (!room) return;

        const participant = room.participants.find(p => p.name === currentUser);
        if (!participant || !participant.isHost) {
            socket.emit('error', '只有主持人可以揭曉結果');
            return;
       }

       if (room.reveal(false)) {
           io.to(currentRoom).emit('roomUpdate', room.getState());
       } else {
           socket.emit('error', '還有人未提交數字');
       }
   });

   socket.on('forceReveal', () => {
       if (!currentRoom || !currentUser) return;
       
       const room = rooms[currentRoom];
       if (!room) return;

       const participant = room.participants.find(p => p.name === currentUser);
       if (!participant || !participant.isHost) {
           socket.emit('error', '只有主持人可以強制揭曉');
           return;
       }

       if (room.reveal(true)) {
           io.to(currentRoom).emit('roomUpdate', room.getState());
       } else {
           socket.emit('error', '無法揭曉結果');
       }
   });

   socket.on('backToLobby', () => {
       if (!currentRoom || !currentUser) return;
       
       const room = rooms[currentRoom];
       if (!room) return;

       const participant = room.participants.find(p => p.name === currentUser);
       if (!participant || !participant.isHost) {
           socket.emit('error', '只有主持人可以返回大廳');
           return;
       }

       if (room.backToLobby()) {
           io.to(currentRoom).emit('roomUpdate', room.getState());
       }
   });

   socket.on('kickUser', (userName) => {
       if (!currentRoom || !currentUser) return;
       
       const room = rooms[currentRoom];
       if (!room) return;

       const participant = room.participants.find(p => p.name === currentUser);
       if (!participant || !participant.isHost) {
           socket.emit('error', '只有主持人可以踢人');
           return;
       }

       if (room.phase !== 'lobby') {
           socket.emit('error', '只能在待機階段踢人');
           return;
       }

       const kickedSocketId = room.kickParticipant(userName);
       if (kickedSocketId) {
           io.to(kickedSocketId).emit('kicked');
           io.to(currentRoom).emit('roomUpdate', room.getState());
       }
   });

   socket.on('leaveRoom', () => {
       handleDisconnect();
   });

   socket.on('disconnect', () => {
       handleDisconnect();
   });

   function handleDisconnect() {
       if (!currentRoom || !currentUser) return;
       
       const room = rooms[currentRoom];
       if (!room) return;

       room.removeParticipant(socket.id);
       
       // 如果房間空了，刪除房間
       if (room.isEmpty()) {
           delete rooms[currentRoom];
       } else {
           io.to(currentRoom).emit('roomUpdate', room.getState());
       }

       socket.leave(currentRoom);
       currentRoom = null;
       currentUser = null;
   }
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`伺服器運行在 http://${HOST}:${PORT}`);
});



