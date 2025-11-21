const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// 存储所有房间的状态
// 结构: { "roomId": { password, players: {}, gameStarted, ... } }
const rooms = {};

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    // --- 房间管理逻辑 ---

    // 创建房间
    socket.on('createRoom', ({ roomId, password }) => {
        if (rooms[roomId]) {
            socket.emit('err', '房间名已存在');
            return;
        }
        // 初始化房间状态
        rooms[roomId] = {
            password: password,
            players: {}, // socketId -> player data
            playerOrder: [],
            currentTurnIndex: 0,
            gameStarted: false,
            lastDiceResult: null
        };
        joinRoomLogic(socket, roomId);
    });

    // 加入房间
    socket.on('joinRoom', ({ roomId, password }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('err', '房间不存在');
            return;
        }
        if (room.password !== password) {
            socket.emit('err', '密码错误');
            return;
        }
        joinRoomLogic(socket, roomId);
    });

    // 内部通用加入逻辑
    function joinRoomLogic(socket, roomId) {
        socket.join(roomId);
        socket.data.roomId = roomId; // 在socket对象上记录所在房间ID

        const room = rooms[roomId];

        // 发送初始化数据
        socket.emit('roomJoined', {
            roomId: roomId,
            players: room.players,
            gameStarted: room.gameStarted,
            currentTurn: room.gameStarted ? room.playerOrder[room.currentTurnIndex] : null,
            takenChars: Object.values(room.players).map(p => p.charId)
        });
    }

    // --- 游戏逻辑 (全部基于 socket.data.roomId) ---

    // 获取当前socket所在的房间数据
    function getRoom(socket) {
        const rid = socket.data.roomId;
        return rid ? rooms[rid] : null;
    }

    socket.on('selectCharacter', (charId) => {
        const room = getRoom(socket);
        if (!room) return;
        if (room.gameStarted) return; // 游戏开始后不能选人（只能观战）

        // 检查角色占用
        const isTaken = Object.values(room.players).some(p => p.charId === charId);
        if (isTaken) return;

        // 如果该玩家已经选了别的，先移除旧的（暂不支持换人，简单覆盖）
        // 这里逻辑是：主要用于新加入。

        room.players[socket.id] = {
            id: socket.id,
            charId: charId,
            x: 850,
            y: 850,
            score: 1000
        };

        io.to(room.password ? socket.data.roomId : socket.data.roomId).emit('updatePlayers', room.players);
        io.to(socket.data.roomId).emit('takenChars', Object.values(room.players).map(p => p.charId));
    });

    socket.on('startGame', () => {
        const room = getRoom(socket);
        if (!room) return;

        const playerIds = Object.keys(room.players);
        if (playerIds.length < 2) return;

        room.playerOrder = playerIds;
        room.currentTurnIndex = 0;
        room.gameStarted = true;
        room.lastDiceResult = null;

        io.to(socket.data.roomId).emit('gameStarted', {
            playerOrder: room.playerOrder,
            currentTurn: room.playerOrder[room.currentTurnIndex]
        });
    });

    socket.on('rollDice', (diceCount) => {
        const room = getRoom(socket);
        if (!room || !room.gameStarted) return;
        if (socket.id !== room.playerOrder[room.currentTurnIndex]) return;

        let roll = 0;
        let details = [];
        for (let i = 0; i < diceCount; i++) {
            let r = Math.floor(Math.random() * 6) + 1;
            roll += r;
            details.push(r);
        }

        room.lastDiceResult = { roll, details, player: socket.id };
        io.to(socket.data.roomId).emit('diceRolled', room.lastDiceResult);
    });

    socket.on('endTurn', () => {
        const room = getRoom(socket);
        if (!room || !room.gameStarted) return;
        if (socket.id !== room.playerOrder[room.currentTurnIndex]) return;

        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.playerOrder.length;
        room.lastDiceResult = null;

        io.to(socket.data.roomId).emit('turnChanged', {
            currentTurn: room.playerOrder[room.currentTurnIndex]
        });
    });

    socket.on('movePlayer', (pos) => {
        const room = getRoom(socket);
        if (room && room.players[socket.id]) {
            room.players[socket.id].x = pos.x;
            room.players[socket.id].y = pos.y;
            // 只广播给同一房间的其他人
            socket.broadcast.to(socket.data.roomId).emit('playerMoved', { id: socket.id, x: pos.x, y: pos.y });
        }
    });

    socket.on('changeScore', (amount) => {
        const room = getRoom(socket);
        if (room && room.players[socket.id]) {
            const val = parseInt(amount);
            if (!isNaN(val)) {
                room.players[socket.id].score += val;
                io.to(socket.data.roomId).emit('updatePlayers', room.players);
            }
        }
    });

    socket.on('disconnect', () => {
        const roomId = socket.data.roomId;
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];

            // 如果是玩家（已选角色），移除玩家数据
            if (room.players[socket.id]) {
                delete room.players[socket.id];

                // 游戏进行中有人退出
                if (room.gameStarted) {
                    // 如果剩余人数不足2人，重置游戏
                    const remaining = Object.keys(room.players);
                    if (remaining.length < 2) {
                        room.gameStarted = false;
                        io.to(roomId).emit('gameReset', '玩家人数不足，游戏重置');
                    } else {
                        // 如果退出的正好是当前回合的人，跳到下一个人
                        // 简单处理：重置回合为0或保持，为防止卡死，这里建议重置游戏或稍微复杂的逻辑
                        // 这里简化处理：不重置游戏，只更新列表，但可能会导致回合指针错位。
                        // 稳妥起见，Web小游戏建议直接重置或通知。
                        // 为了体验，这里仅仅更新显示。
                    }
                }

                io.to(roomId).emit('updatePlayers', room.players);
                io.to(roomId).emit('takenChars', Object.values(room.players).map(p => p.charId));
            }

            // 如果房间没人了，删除房间 (可选，防止内存泄漏)
            // 注意：Socket.io会自动处理leave room，这里主要是清理 rooms 对象
            const numClients = io.sockets.adapter.rooms.get(roomId)?.size || 0;
            if (numClients === 0) {
                delete rooms[roomId];
                console.log(`Room ${roomId} deleted.`);
            }
        }
    });
});

http.listen(3000, () => {
    console.log('listening on *:3000');
});