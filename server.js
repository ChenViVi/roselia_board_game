const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// 游戏状态
let players = {};
let playerOrder = [];
let currentTurnIndex = 0;
let gameStarted = false;
let lastDiceResult = null;

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.emit('init', {
        players,
        gameStarted,
        currentTurn: gameStarted ? playerOrder[currentTurnIndex] : null,
        takenChars: Object.values(players).map(p => p.charId)
    });

    socket.on('selectCharacter', (charId) => {
        if (gameStarted) return;
        const isTaken = Object.values(players).some(p => p.charId === charId);
        if (isTaken) return;

        players[socket.id] = {
            id: socket.id,
            charId: charId,
            x: 850,
            y: 850,
            score: 0 // --- 新增：初始分数，大富翁通常有初始资金，设为1000 ---
        };

        io.emit('updatePlayers', players);
        io.emit('takenChars', Object.values(players).map(p => p.charId));
    });

    socket.on('startGame', () => {
        const playerIds = Object.keys(players);
        if (playerIds.length < 2) return;

        playerOrder = playerIds;
        currentTurnIndex = 0;
        gameStarted = true;
        lastDiceResult = null;

        io.emit('gameStarted', {
            playerOrder,
            currentTurn: playerOrder[currentTurnIndex]
        });
    });

    socket.on('rollDice', (diceCount) => {
        if (!gameStarted) return;
        if (socket.id !== playerOrder[currentTurnIndex]) return;

        let roll = 0;
        let details = [];
        for (let i = 0; i < diceCount; i++) {
            let r = Math.floor(Math.random() * 6) + 1;
            roll += r;
            details.push(r);
        }

        lastDiceResult = { roll, details, player: socket.id };
        io.emit('diceRolled', lastDiceResult);
    });

    socket.on('endTurn', () => {
        if (!gameStarted) return;
        if (socket.id !== playerOrder[currentTurnIndex]) return;

        currentTurnIndex = (currentTurnIndex + 1) % playerOrder.length;
        lastDiceResult = null;
        io.emit('turnChanged', {
            currentTurn: playerOrder[currentTurnIndex]
        });
    });

    socket.on('movePlayer', (pos) => {
        if (players[socket.id]) {
            players[socket.id].x = pos.x;
            players[socket.id].y = pos.y;
            socket.broadcast.emit('playerMoved', { id: socket.id, x: pos.x, y: pos.y });
        }
    });

    // --- 新增：修改分数接口 ---
    socket.on('changeScore', (amount) => {
        // 只有存在该玩家时才修改
        if (players[socket.id]) {
            // 确保是数字
            const val = parseInt(amount);
            if (!isNaN(val)) {
                players[socket.id].score += val;
                // 广播更新后的所有玩家信息
                io.emit('updatePlayers', players);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        delete players[socket.id];
        if (gameStarted) {
            playerOrder = playerOrder.filter(id => id !== socket.id);
            if (playerOrder.length < 2) {
                gameStarted = false;
                io.emit('gameReset');
            }
        }
        io.emit('updatePlayers', players);
        io.emit('takenChars', Object.values(players).map(p => p.charId));
    });
});

http.listen(3000, () => {
    console.log('listening on *:3000');
});