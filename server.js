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
const { BOT_TOKEN, MONGODB_URI, PORT = 10000, MINI_APP_URL, SMS_SECRET = "MY_SECRET_KEY", ADMIN_ID } = process.env;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 1. DATABASE MODELS ---
mongoose.connect(MONGODB_URI).then(() => console.log("✅ DB Connected"));

const User = mongoose.model('User', new mongoose.Schema({
    telegramId: { type: String, unique: true },
    username: String,
    phoneNumber: { type: String, default: "Not Registered" },
    balance: { type: Number, default: 0 },
    isRegistered: { type: Boolean, default: false },
    totalGamesPlayed: { type: Number, default: 0 } // For Global Rank
}));

const VerifiedSMS = mongoose.model('VerifiedSMS', new mongoose.Schema({
    refNumber: { type: String, unique: true },
    amount: Number,
    fullText: String,
    isUsed: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, expires: 172800 } 
}));

// NEW: Model for Game History
const GameRecord = mongoose.model('GameRecord', new mongoose.Schema({
    gameId: String,
    telegramId: String,
    username: String,
    stake: Number,
    prize: { type: Number, default: 0 },
    status: { type: String, enum: ['Won', 'Lost'], default: 'Lost' },
    createdAt: { type: Date, default: Date.now }
}));

// NEW: Model for Wallet History
const Transaction = mongoose.model('Transaction', new mongoose.Schema({
    telegramId: String,
    type: { type: String, enum: ['Deposit', 'Withdraw'] },
    amount: Number,
    ref: String,
    status: { type: String, default: 'Approved' },
    createdAt: { type: Date, default: Date.now }
}));

// --- 2. SMS API ---
app.all('/api/incoming-sms', async (req, res) => {
    const incomingText = req.body.text || req.body.message || req.query.text || "";
    const data = parseBankSMS(incomingText);
    if (data) {
        try { await VerifiedSMS.create({ refNumber: data.ref, amount: data.amount, fullText: incomingText }); } catch (e) {}
    }
    res.status(200).send("OK");
});
app.get('/ping', (req, res) => res.status(200).send("Awake"));

// --- 3. BINGO ENGINE ---
function parseBankSMS(text) {
    if (!text) return null;
    const refMatch = text.match(/[A-Z0-9]{10,12}/);
    const amountMatch = text.match(/(?:Birr|ETB|amt|amount)[:\s]*?([0-9.]+)/i) || text.match(/([0-9.]+)\s*?Birr/i);
    return (refMatch && amountMatch) ? { ref: refMatch[0], amount: parseFloat(amountMatch[1]) } : null;
}

function generateServerCard(id) {
    const seed = parseInt(id) || 1;
    const rng = (s) => { let t = s += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    let columns = [];
    const ranges = [[1,15],[16,30],[31,45],[46,60],[61,75]];
    for(let i=0; i<5; i++) {
        let col = []; let [min, max] = ranges[i]; let pool = Array.from({length: max-min+1}, (_, k) => k + min);
        for(let j=0; j<5; j++) { let idx = Math.floor(rng(seed + i * 10 + j) * pool.length); col.push(pool.splice(idx, 1)[0]); }
        columns.push(col);
    }
    let card = []; for(let r=0; r<5; r++) card.push([columns[0][r], columns[1][r], columns[2][r], columns[3][r], columns[4][r]]);
    card[2][2] = 0; return card;
}

function checkServerWin(card, drawnNumbers) {
    const drawn = new Set(drawnNumbers); drawn.add(0);
    for (let i = 0; i < 5; i++) {
        if (card[i].every(n => drawn.has(n))) return true;
        if ([0,1,2,3,4].map(r => card[r][i]).every(n => drawn.has(n))) return true;
    }
    if ([0,1,2,3,4].map(i => card[i][i]).every(n => drawn.has(n))) return true;
    if ([0,1,2,3,4].map(i => card[i][4-i]).every(n => drawn.has(n))) return true;
    return false;
}

// --- 4. GAME STATE & LOOP ---
let currentId = "BBU7EN94"; // Mock ID or auto-generate
let gameState = { phase: 'SELECTION', phaseEndTime: Date.now() + 40000, timer: 40, drawnNumbers: [], pot: 0, winner: null, totalPlayers: 0, takenCards: [] };
let players = {}; let socketToUser = {};

setInterval(async () => {
    const now = Date.now();
    let timeLeft = Math.ceil((gameState.phaseEndTime - now) / 1000);
    if (timeLeft < 0) timeLeft = 0;
    gameState.timer = timeLeft;

    if (gameState.phase === 'SELECTION') {
        let total = 0; Object.values(players).forEach(p => { if (p.cards) total += p.cards.length; });
        gameState.totalPlayers = total; gameState.pot = total * 10;
        if (timeLeft <= 0) {
            if (total >= 2) {
                gameState.phase = 'GAMEPLAY';
                for (let tid in players) {
                    if (players[tid].cards?.length > 0) {
                        const cost = players[tid].cards.length * 10;
                        await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: -cost, totalGamesPlayed: 1 } });
                        
                        // NEW: Create Initial Lost Record (Updates to Won if they win)
                        await GameRecord.create({
                            gameId: currentId,
                            telegramId: tid,
                            username: players[tid].username,
                            stake: cost,
                            status: 'Lost'
                        });

                        const u = await User.findOne({ telegramId: tid });
                        if(u) io.to(tid).emit('balance_update', u.balance);
                    }
                }
            } else { gameState.phaseEndTime = Date.now() + 40000; }
        }
    }
    if (gameState.phase === 'WINNER' && timeLeft <= 0) {
        currentId = Math.random().toString(36).substring(2, 10).toUpperCase(); // Rotate Game ID
        gameState = { phase: 'SELECTION', phaseEndTime: Date.now() + 40000, timer: 40, drawnNumbers: [], pot: 0, winner: null, totalPlayers: 0, takenCards: [] };
        for (let tid in players) players[tid].cards = [];
        io.emit('restore_cards', []); 
    }
    io.emit('game_tick', gameState);
}, 1000);

setInterval(() => {
    if (gameState.phase === 'GAMEPLAY' && !gameState.winner && gameState.drawnNumbers.length < 75) {
        let n; do { n = Math.floor(Math.random() * 75) + 1; } while (gameState.drawnNumbers.includes(n));
        gameState.drawnNumbers.push(n); io.emit('number_drawn', gameState.drawnNumbers);
    }
}, 2500);

// --- 5. SOCKETS (INTEGRATED WITH REAL DATA) ---
io.on('connection', (socket) => {
    socket.on('register_user', async (data) => {
        try {
            const urlParams = new URLSearchParams(data.initData); const user = JSON.parse(urlParams.get('user')); const tid = user.id.toString();
            socket.join(tid); socketToUser[socket.id] = tid;
            const u = await User.findOne({ telegramId: tid });
            if (u) {
                if (!u.isRegistered) return socket.emit('error_message', "መጀመሪያ በBot ውስጥ ስልክዎን Share በማድረግ ይመዝገቡ!");
                socket.emit('user_data', { balance: u.balance, phoneNumber: u.phoneNumber });
                if (!players[tid]) players[tid] = { cards: [], username: u.username };
                if (players[tid].cards.length > 0) socket.emit('restore_cards', players[tid].cards);
            }
        } catch (e) {}
    });

    // NEW: Real-time Data Fetchers for Mini App
    socket.on('fetch_scores', async () => {
        const dailyLimit = new Date(); dailyLimit.setHours(0,0,0,0);
        const weeklyLimit = new Date(); weeklyLimit.setDate(weeklyLimit.getDate() - 7);

        // Calculate Daily/Weekly based on GameRecords
        const daily = await GameRecord.aggregate([
            { $match: { createdAt: { $gte: dailyLimit } } },
            { $group: { _id: "$telegramId", username: { $first: "$username" }, count: { $sum: 1 } } },
            { $sort: { count: -1 } }, { $limit: 10 }
        ]);

        const weekly = await GameRecord.aggregate([
            { $match: { createdAt: { $gte: weeklyLimit } } },
            { $group: { _id: "$telegramId", username: { $first: "$username" }, count: { $sum: 1 } } },
            { $sort: { count: -1 } }, { $limit: 10 }
        ]);

        socket.emit('scores_data', { daily, weekly });
    });

    socket.on('fetch_history', async () => {
        const tid = socketToUser[socket.id];
        const history = await GameRecord.find({ telegramId: tid }).sort({ createdAt: -1 }).limit(10);
        socket.emit('history_data', history);
    });

    socket.on('fetch_wallet_history', async () => {
        const tid = socketToUser[socket.id];
        const wallet = await Transaction.find({ telegramId: tid }).sort({ createdAt: -1 }).limit(10);
        socket.emit('wallet_history_data', wallet);
    });

    socket.on('buy_card', async (cardIds) => {
        const tid = socketToUser[socket.id];
        if (tid && gameState.phase === 'SELECTION') {
            const u = await User.findOne({ telegramId: tid });
            if (!u || u.balance < cardIds.length * 10) return socket.emit('error_message', "Insufficient Balance!");
            players[tid].cards = cardIds;
            let all = []; Object.values(players).forEach(pl => { if(pl.cards) all.push(...pl.cards); });
            gameState.takenCards = all;
        }
    });

    socket.on('claim_win', async (data) => {
        const tid = socketToUser[socket.id];
        if (tid && gameState.phase === 'GAMEPLAY' && !gameState.winner) {
            const card = generateServerCard(data.cardId);
            if (checkServerWin(card, gameState.drawnNumbers)) {
                const prize = Math.floor(gameState.pot * 0.8);
                gameState.winner = { username: players[tid].username, prize, cardId: data.cardId };
                const u = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: prize } }, { new: true });
                
                // NEW: Update History to "Won"
                await GameRecord.findOneAndUpdate(
                    { gameId: currentId, telegramId: tid },
                    { status: 'Won', prize: prize }
                );

                if(u) io.to(tid).emit('balance_update', u.balance);
                gameState.phase = 'WINNER'; gameState.phaseEndTime = Date.now() + 7000; io.emit('game_tick', gameState);
            }
        }
    });
});

// --- 6. BOT LOGIC ---
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

bot.telegram.setMyCommands([
    { command: 'start', description: 'Start' }, { command: 'register', description: 'Register' },
    { command: 'play', description: 'Play' }, { command: 'deposit', description: 'Deposit' },
    { command: 'balance', description: 'Balance' }, { command: 'withdraw', description: 'Withdraw' },
    { command: 'transfer', description: 'Transfer' }, { command: 'instruction', description: 'Instruction' },
    { command: 'support', description: 'Support' }
]);
bot.telegram.setChatMenuButton({ menuButton: { type: 'default' } });

const mainKeyboard = (isRegistered) => {
    const rows = isRegistered ? [[Markup.button.webApp("Play 🎮", MINI_APP_URL), Markup.button.callback("Register 📝", "reg_prompt")]] : [[Markup.button.callback("Register 📝", "reg_prompt")]];
    rows.push([Markup.button.callback("Check Balance 💵", "bal"), Markup.button.callback("Deposit 💰", "dep")], [Markup.button.callback("Contact Support...", "support_trigger"), Markup.button.callback("Instruction 📖", "instructions_trigger")], [Markup.button.callback("Transfer 🎁", "transfer"), Markup.button.callback("Withdraw 🤑", "withdraw_start")], [Markup.button.callback("Invite 🔗", "invite")]);
    return Markup.inlineKeyboard(rows);
};

bot.start(async (ctx) => {
    const user = await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { username: ctx.from.first_name }, { upsert: true, new: true });
    if (!user.isRegistered) await ctx.reply("👋 Welcome! Please share your contact to earn 10 Birr Bonus.", Markup.keyboard([[Markup.button.contactRequest("📞 Share contact")]]).resize().oneTime());
    await ctx.reply(`👋 Welcome to Dil Bingo!`, mainKeyboard(user.isRegistered));
});

bot.on('contact', async (ctx) => {
    const existing = await User.findOne({ telegramId: ctx.from.id.toString() });
    let bonus = 0; if (existing && !existing.isRegistered) bonus = 10;
    await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { phoneNumber: ctx.message.contact.phone_number, isRegistered: true, $inc: { balance: bonus } });
    ctx.reply(`✅ ተመዝግበዋል! ${bonus > 0 ? "\n🎁 10 ብር ቦነስ ተጨምሯል!" : ""}`, Markup.removeKeyboard());
    ctx.reply("Main Menu:", mainKeyboard(true));
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text; const uid = ctx.from.id.toString();
    if (ctx.session?.state === 'WAIT_AMT') {
        const amt = parseInt(text); if (isNaN(amt) || amt < 10) return ctx.reply("ከ 10 ብር በላይ ያስገቡ።");
        ctx.session.amount = amt; ctx.session.state = null;
        return ctx.reply(`የመረጡት መጠን: ${amt} ብር\nዘዴ ይምረጡ:`, Markup.inlineKeyboard([[Markup.button.callback("TELEBIRR", "pay_tele"), Markup.button.callback("CBE", "pay_cbe")],[Markup.button.callback("ABYSSINIA", "pay_aby"), Markup.button.callback("CBE BIRR", "pay_cbebirr")]]));
    }
    const data = parseBankSMS(text);
    if (data) {
        const record = await VerifiedSMS.findOne({ refNumber: data.ref, isUsed: false });
        if (record) {
            record.isUsed = true; await record.save();
            const u = await User.findOneAndUpdate({ telegramId: uid }, { $inc: { balance: record.amount } }, { new: true });
            
            // NEW: Record Deposit History
            await Transaction.create({ telegramId: uid, type: 'Deposit', amount: record.amount, ref: data.ref });
            
            io.to(uid).emit('balance_update', u.balance); ctx.reply(`✅ ${record.amount} ብር ገብቷል።`);
        }
    }
});

bot.action('withdraw_start', async (ctx) => {
    const u = await User.findOne({ telegramId: ctx.from.id.toString() });
    if (!u || u.balance < 50) return ctx.reply("ዝቅተኛው 50 ብር ነው::");
    ctx.session = { state: 'WAIT_W_AMT' }; ctx.reply("💰 መጠን ያስገቡ ?");
});

// Instruction Handlers, Bank Handlers, etc (KEEP AS PROVIDED PREVIOUSLY)
const supportHeader = `የሚያጋጥማቹ የክፍያ ችግር: \n @sya9744\n@Komodo27 ላይ ፃፉልን።`;
bot.action('pay_tele', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 0922573939 (SEID) ${ctx.session.amount || 10} ብር ይላኩ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('pay_cbe', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 1000102526418 (Acc) ${ctx.session.amount || 10} ብር ያስገቡ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('pay_aby', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 88472845 (Acc) ${ctx.session.amount || 10} ብር ያስገቡ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('pay_cbebirr', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 0922573939 (CBE BIRR) ${ctx.session.amount || 10} ብር ይላኩ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('bal', async (ctx) => { const u = await User.findOne({ telegramId: ctx.from.id.toString() }); ctx.reply(`💰 Balance: ${u?.balance || 0} Birr`); });
bot.action('support_trigger', (ctx) => ctx.reply(`🛠 Support:\n👉 @sya9744\n👉 @komodo27`));
bot.action('instructions_trigger', (ctx) => { 
    const htmlText = `<b>📘 የቢንጎ ጨዋታ ህጎች</b>\n\n` +
    `<blockquote><b>🃏 መጫወቻ ካርድ</b>\n1. ከ1-300 ካርድ አንዱን እንመርጣለን።\n2. ቀይ ማለት ሌላ ሰው መርጦታል።</blockquote>\n` +
    `<blockquote><b>🎮 ጨዋታ</b>\n1. ቁጥሮች ከ1-75 ይጠራሉ::\n2. ካርዶ ላይ ካለ ይምረጡ::</blockquote>`;
    ctx.replyWithHTML(htmlText);
});

bot.launch();

// --- 7. SERVE FRONTEND ---
const publicPath = path.resolve(__dirname, 'public');
app.use(express.static(publicPath));
app.get('*', (req, res) => {
    if (req.path.includes('.') && !req.path.endsWith('.html')) return res.status(404).end();
    res.sendFile(path.join(publicPath, 'index.html'));
});
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Live on ${PORT}`));
