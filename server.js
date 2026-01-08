require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

// --- CONFIG ---
const { BOT_TOKEN, MONGODB_URI, PORT = 3001, MINI_APP_URL } = process.env;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// --- DATABASE ---
mongoose.connect(MONGODB_URI).then(() => console.log("✅ MongoDB Connected"));

const User = mongoose.model('User', new mongoose.Schema({
    telegramId: { type: String, unique: true },
    username: String,
    phoneNumber: String,
    balance: { type: Number, default: 0 },
    isRegistered: { type: Boolean, default: false }
}));

const VerifiedSMS = mongoose.model('VerifiedSMS', new mongoose.Schema({
    refNumber: { type: String, unique: true },
    amount: Number,
    isUsed: { type: Boolean, default: false }
}));

// --- BINGO UTILS ---
function generateServerCard(id) {
    const seed = parseInt(id) || 1;
    const rng = (s) => {
        let t = s += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    let columns = [];
    const ranges = [[1,15],[16,30],[31,45],[46,60],[61,75]];
    for(let i=0; i<5; i++) {
        let col = [];
        let [min, max] = ranges[i];
        let pool = Array.from({length: max-min+1}, (_, k) => k + min);
        for(let j=0; j<5; j++) {
            let idx = Math.floor(rng(seed + i * 10 + j) * pool.length);
            col.push(pool.splice(idx, 1)[0]);
        }
        columns.push(col);
    }
    let card = [];
    for(let r=0; r<5; r++) card.push([columns[0][r], columns[1][r], columns[2][r], columns[3][r], columns[4][r]]);
    card[2][2] = 0; 
    return card;
}

function checkServerWin(card, drawnNumbers) {
    const drawn = new Set(drawnNumbers);
    drawn.add(0);
    for (let i = 0; i < 5; i++) {
        if (card[i].every(n => drawn.has(n))) return true;
        if ([0,1,2,3,4].map(r => card[r][i]).every(n => drawn.has(n))) return true;
    }
    if ([0,1,2,3,4].map(i => card[i][i]).every(n => drawn.has(n))) return true;
    if ([0,1,2,3,4].map(i => card[i][4-i]).every(n => drawn.has(n))) return true;
    return false;
}

// --- GAME STATE ---
let gameState = { 
    phase: 'SELECTION', 
    phaseEndTime: Date.now() + 40000, 
    timer: 40, 
    drawnNumbers: [], 
    pot: 0, 
    winner: null, 
    totalPlayers: 0, 
    takenCards: [] 
};
let players = {}; 
let socketToUser = {};

// Main Game Loop
setInterval(async () => {
    const now = Date.now();
    let timeLeft = Math.ceil((gameState.phaseEndTime - now) / 1000);
    if (timeLeft < 0) timeLeft = 0;
    gameState.timer = timeLeft;

    if (gameState.phase === 'SELECTION') {
        let totalCardsSold = 0;
        Object.values(players).forEach(p => { if (p.cards) totalCardsSold += p.cards.length; });
        
        gameState.totalPlayers = totalCardsSold;
        gameState.pot = totalCardsSold * 10;

        // If time is up
        if (timeLeft <= 0) {
            if (totalCardsSold >= 2) {
                // START GAME
                gameState.phase = 'GAMEPLAY';
                for (let tid in players) {
                    if (players[tid].cards?.length > 0) {
                        const cost = players[tid].cards.length * 10;
                        const u = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: -cost } }, { new: true });
                        if(u) io.to(tid).emit('balance_update', u.balance);
                    }
                }
            } else {
                // RESET TIMER: Not enough cartelas (less than 2)
                gameState.phaseEndTime = Date.now() + 40000;
                gameState.timer = 40;
            }
        }
    }

    if (gameState.phase === 'WINNER' && timeLeft <= 0) {
        gameState = { phase: 'SELECTION', phaseEndTime: Date.now() + 40000, timer: 40, drawnNumbers: [], pot: 0, winner: null, totalPlayers: 0, takenCards: [] };
        for (let tid in players) players[tid].cards = [];
        io.emit('restore_cards', []); 
    }
    io.emit('game_tick', gameState);
}, 1000);

// Faster Drawing (2.5 Seconds)
setInterval(() => {
    if (gameState.phase === 'GAMEPLAY' && !gameState.winner && gameState.drawnNumbers.length < 75) {
        let n;
        do { n = Math.floor(Math.random() * 75) + 1; } while (gameState.drawnNumbers.includes(n));
        gameState.drawnNumbers.push(n);
        io.emit('number_drawn', gameState.drawnNumbers);
    }
}, 2500); // Changed from 4000 to 2500 for speed

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('register_user', async (data) => {
        try {
            const urlParams = new URLSearchParams(data.initData);
            const userData = JSON.parse(urlParams.get('user'));
            const tid = userData.id.toString();
            socket.join(tid);
            socketToUser[socket.id] = tid;
            const u = await User.findOne({ telegramId: tid });
            if (u) {
                socket.emit('balance_update', u.balance);
                if (!players[tid]) players[tid] = { cards: [], username: u.username };
                if (players[tid].cards.length > 0) socket.emit('restore_cards', players[tid].cards);
            }
        } catch (e) {}
    });

    socket.on('buy_card', async (cardIds) => {
        const tid = socketToUser[socket.id];
        if (tid && gameState.phase === 'SELECTION') {
            const u = await User.findOne({ telegramId: tid });
            if (!u || u.balance < cardIds.length * 10) return socket.emit('error_message', "Insufficient Balance!");
            
            players[tid].cards = cardIds;
            let all = [];
            Object.values(players).forEach(pl => { if(pl.cards) all.push(...pl.cards); });
            gameState.takenCards = all;
        }
    });

    socket.on('claim_win', async (data) => {
        const tid = socketToUser[socket.id];
        if (tid && gameState.phase === 'GAMEPLAY' && !gameState.winner) {
            const card = generateServerCard(data.cardId);
            if (checkServerWin(card, gameState.drawnNumbers)) {
                // 80% to Winner, 20% to Admin
                const prize = Math.floor(gameState.pot * 0.8);
                gameState.winner = { username: players[tid].username, prize, cardId: data.cardId };
                await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: prize } });
                gameState.phase = 'WINNER'; 
                gameState.phaseEndTime = Date.now() + 10000;
                io.emit('game_tick', gameState);
            }
        }
    });
    socket.on('disconnect', () => { delete socketToUser[socket.id]; });
});

// --- TELEGRAM BOT ---
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

const menu = () => Markup.inlineKeyboard([
    [Markup.button.webApp("Play Bingo 🎮", MINI_APP_URL)],
    [Markup.button.callback("Check Balance 💵", "bal"), Markup.button.callback("Deposit 💰", "dep")]
]);

bot.start(async (ctx) => {
    const user = await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { username: ctx.from.first_name }, { upsert: true, new: true });
    if (!user.isRegistered) {
        return ctx.reply("Please register your phone to play.", Markup.keyboard([[Markup.button.contactRequest("📱 Register Phone")]]).resize().oneTime());
    }
    ctx.reply(`Welcome back ${user.username}!`, menu());
});

bot.on('contact', async (ctx) => {
    await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { phoneNumber: ctx.message.contact.phone_number, isRegistered: true });
    ctx.reply("✅ Registered!", menu());
});

bot.on('text', async (ctx) => {
    const refMatch = ctx.message.text.match(/[A-Z0-9]{10,12}/);
    if (refMatch) {
        const sms = await VerifiedSMS.findOne({ refNumber: refMatch[0], isUsed: false });
        if (sms) {
            sms.isUsed = true; await sms.save();
            const u = await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { $inc: { balance: sms.amount } }, { new: true });
            io.to(u.telegramId).emit('balance_update', u.balance);
            ctx.reply(`✅ Added ${sms.amount} Birr!`);
        }
    }
});

bot.action('bal', async (ctx) => {
    const u = await User.findOne({ telegramId: ctx.from.id.toString() });
    ctx.answerCbQuery();
    ctx.reply(`Balance: ${u?.balance || 0} Birr`);
});

bot.launch().then(() => console.log("🤖 Bot Live"));

// --- STATIC SERVING ---
const publicPath = path.resolve(__dirname, 'public');
app.use(express.static(publicPath));
app.get('*', (req, res) => {
    if (req.path.includes('.') && !req.path.endsWith('.html')) return res.status(404).end();
    res.sendFile(path.join(publicPath, 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Live on ${PORT}`));