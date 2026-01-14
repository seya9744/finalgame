require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const { BOT_TOKEN, MONGODB_URI, PORT = 10000, MINI_APP_URL, SMS_SECRET = "MY_SECRET_KEY", ADMIN_ID } = process.env;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

mongoose.connect(MONGODB_URI).then(() => console.log("✅ DB Connected"));

// --- MODELS ---
const User = mongoose.model('User', new mongoose.Schema({
    telegramId: { type: String, unique: true },
    username: String,
    phoneNumber: { type: String, default: "Not Registered" },
    balance: { type: Number, default: 0 },
    gamesWon: { type: Number, default: 0 }, 
    totalPlayed: { type: Number, default: 0 }, 
    isRegistered: { type: Boolean, default: false }
}));

const GameRecord = mongoose.model('GameRecord', new mongoose.Schema({
    telegramId: String, gameId: String, status: String, stake: Number, prize: Number, date: { type: Date, default: Date.now }
}));

const VerifiedSMS = mongoose.model('VerifiedSMS', new mongoose.Schema({
    refNumber: { type: String, unique: true }, amount: Number, fullText: String, isUsed: { type: Boolean, default: false }, usedBy: { type: String, default: null }, createdAt: { type: Date, default: Date.now, expires: 172800 } 
}));

// --- ENGINES ---
function parseBankSMS(text) {
    if (!text) return null;
    const refMatch = text.match(/[A-Z0-9]{10,12}/);
    const amountMatch = text.match(/(?:Birr|ETB|amt|amount)[:\s]*?([0-9.]+)/i) || text.match(/([0-9.]+)\s*?Birr/i);
    return (refMatch && amountMatch) ? { ref: refMatch[0], amount: parseFloat(amountMatch[1]) } : null;
}

function generateServerCard(id) {
    const cardId = parseInt(id) || 1;
    let state = (cardId * 15485863) ^ 0x6D2B79F5; 
    const nextRng = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
    let columns = []; const ranges = [[1,15],[16,30],[31,45],[46,60],[61,75]];
    for(let i=0; i<5; i++) {
        let col = []; let [min, max] = ranges[i]; let pool = Array.from({length: max-min+1}, (_, k) => k + min);
        for(let j=0; j<5; j++) { let idx = Math.floor(nextRng() * pool.length); col.push(pool.splice(idx, 1)[0]); }
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
    const d1 = [0,1,2,3,4].map(i => card[i][i]); if (d1.every(n => drawn.has(n))) return true;
    const d2 = [0,1,2,3,4].map(i => card[i][4-i]); if (d2.every(n => drawn.has(n))) return true;
    const corners = [card[0][0], card[0][4], card[4][0], card[4][4]]; if (corners.every(n => drawn.has(n))) return true;
    return false;
}

// --- LOOP ---
let gameState = { phase: 'SELECTION', phaseEndTime: Date.now() + 40000, timer: 40, drawnNumbers: [], pot: 0, winner: null, totalPlayers: 0, takenCards: [] };
let players = {}; let socketToUser = {};

setInterval(async () => {
    const now = Date.now();
    let timeLeft = Math.ceil((gameState.phaseEndTime - now) / 1000);
    if (timeLeft < 0) timeLeft = 0;
    gameState.timer = timeLeft;

    if (gameState.phase === 'SELECTION' && timeLeft <= 0) {
        let total = 0; let allT = [];
        Object.values(players).forEach(p => { if (p.cards) { total += p.cards.length; allT.push(...p.cards); } });
        if (total >= 2) {
            gameState.phase = 'GAMEPLAY';
            for (let tid in players) {
                if (players[tid].cards?.length > 0) {
                    await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: -(players[tid].cards.length * 10) } });
                    const u = await User.findOne({ telegramId: tid });
                    if(u) io.to(tid).emit('balance_update', u.balance);
                }
            }
        } else { gameState.phaseEndTime = Date.now() + 40000; }
    }
    if (gameState.phase === 'WINNER' && timeLeft <= 0) {
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

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('register_user', async (data) => {
        try {
            const urlParams = new URLSearchParams(data.initData); const user = JSON.parse(urlParams.get('user')); const tid = user.id.toString();
            socket.join(tid); socketToUser[socket.id] = tid;
            const u = await User.findOne({ telegramId: tid });
            if (u) {
                if (!u.isRegistered) return socket.emit('error_message', "መጀመሪያ Register ያድርጉ!");
                socket.emit('user_data', { balance: u.balance, phoneNumber: u.phoneNumber });
                if (!players[tid]) players[tid] = { cards: [], username: u.username };
                if (players[tid].cards.length > 0) socket.emit('restore_cards', players[tid].cards);
            }
        } catch (e) {}
    });

    socket.on('buy_card', (cardIds) => {
        const tid = socketToUser[socket.id];
        if (tid && gameState.phase === 'SELECTION') {
            if (cardIds.length > 2) return;
            players[tid].cards = cardIds;
            let allT = []; let total = 0;
            Object.values(players).forEach(pl => { if(pl.cards) { allT.push(...pl.cards); total += pl.cards.length; } });
            gameState.takenCards = allT; gameState.totalPlayers = total; gameState.pot = total * 10;
            io.emit('game_tick', gameState); 
        }
    });

    socket.on('claim_win', async (data) => {
        const tid = socketToUser[socket.id];
        if (tid && gameState.phase === 'GAMEPLAY' && !gameState.winner) {
            const card = generateServerCard(data.cardId);
            if (checkServerWin(card, gameState.drawnNumbers)) {
                const prize = Math.floor(gameState.pot * 0.8);
                gameState.winner = { username: players[tid].username, prize, cardId: data.cardId };
                await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: prize, gamesWon: 1, totalPlayed: 1 } });
                await GameRecord.create({ telegramId: tid, gameId: "BBU7EN", status: "Won", stake: players[tid].cards.length * 10, prize: prize });
                for (let otherTid in players) {
                    if (otherTid !== tid && players[otherTid].cards?.length > 0) {
                        await User.findOneAndUpdate({ telegramId: otherTid }, { $inc: { totalPlayed: 1 } });
                        await GameRecord.create({ telegramId: otherTid, gameId: "BBU7EN", status: "Lost", stake: players[otherTid].cards.length * 10, prize: 0 });
                    }
                }
                const u = await User.findOne({ telegramId: tid });
                io.to(tid).emit('balance_update', u.balance);
                gameState.phase = 'WINNER'; gameState.phaseEndTime = Date.now() + 7000; io.emit('game_tick', gameState);
            }
        }
    });

    // 🛠️ FIXED: RE-CALCULATE RANKING BASED ON TIME (Daily/Weekly)
    socket.on('get_leaderboard', async (period) => {
        let startTime = new Date();
        if (period === 'Daily') startTime.setHours(0, 0, 0, 0);
        else if (period === 'Weekly') startTime.setDate(startTime.getDate() - 7);
        else startTime = new Date(0); // All time

        const top = await GameRecord.aggregate([
            { $match: { date: { $gte: startTime } } },
            { $group: { _id: "$telegramId", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 },
            { $lookup: { from: "users", localField: "_id", foreignField: "telegramId", as: "user" } },
            { $unwind: "$user" },
            { $project: { username: "$user.username", totalPlayed: "$count" } }
        ]);
        socket.emit('leaderboard_data', top);
    });

    socket.on('get_history', async (data) => {
        try {
            const urlParams = new URLSearchParams(data.initData); const user = JSON.parse(urlParams.get('user'));
            const history = await GameRecord.find({ telegramId: user.id.toString() }).sort({ date: -1 }).limit(15);
            socket.emit('history_data', history);
        } catch (e) {}
    });

    socket.on('get_wallet_history', async (data) => {
        try {
            const urlParams = new URLSearchParams(data.initData); const user = JSON.parse(urlParams.get('user'));
            const deposits = await VerifiedSMS.find({ usedBy: user.id.toString() }).sort({ createdAt: -1 }).limit(10);
            socket.emit('wallet_history_data', deposits);
        } catch (e) {}
    });
});

// --- BOT ---
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());
const mainKeyboard = (isReg) => Markup.inlineKeyboard([
    isReg ? [Markup.button.webApp("Play 🎮", MINI_APP_URL), Markup.button.callback("Register 📝", "reg")] : [Markup.button.callback("Register 📝", "reg")],
    [Markup.button.callback("Check Balance 💵", "bal"), Markup.button.callback("Deposit 💰", "dep")],
    [Markup.button.callback("Contact Support...", "sup"), Markup.button.callback("Instruction 📖", "rule")],
    [Markup.button.callback("Withdraw 🤑", "w_start")]
]);
const supportHeader = `የሚያጋጥማቹ የክፍያ ችግር: \n @sya9744\n@Komodo27 ላይ ፃፉልን።`;

bot.start(async (ctx) => {
    const user = await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { username: ctx.from.first_name }, { upsert: true, new: true });
    if (!user.isRegistered) await ctx.reply("Share contact for 10 Birr Bonus.", Markup.keyboard([[Markup.button.contactRequest("📞 Share contact")]]).resize().oneTime());
    await ctx.reply(`👋 Welcome to Dil Bingo! Choose below:`, mainKeyboard(user.isRegistered));
});

bot.on('contact', async (ctx) => {
    const ex = await User.findOne({ telegramId: ctx.from.id.toString() });
    let msg = "";
    if (ex && !ex.isRegistered) {
        await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { phoneNumber: ctx.message.contact.phone_number, isRegistered: true, $inc: { balance: 10 } });
        msg = "\n🎁 ለእርሶ የ 10 ብር ቦነስ ተጨምሯል!";
    } else { await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { phoneNumber: ctx.message.contact.phone_number, isRegistered: true }); }
    ctx.reply(`✅ ተመዝግበዋል!${msg}`, Markup.removeKeyboard());
    ctx.reply("Main Menu:", mainKeyboard(true));
});

bot.action('rule', (ctx) => {
    const html = `<b>📘 የቢንጎ ጨዋታ ህጎች</b>\n\n<blockquote><b>🃏 መጫወቻ ካርድ</b>\n\n1. ከ1-300 ካርድ እንመርጣለን።\n2. ቀይ ማለት ሌላ ሰው መርጦታል።\n3. ሲነኩት Preview ያሳየናል።</blockquote>`;
    ctx.replyWithHTML(html);
});

bot.on('text', async (ctx) => {
    const txt = ctx.message.text; const uid = ctx.from.id.toString();
    if (ctx.session?.state === 'WAIT_AMT') {
        const a = parseInt(txt); if (isNaN(a) || a < 10) return ctx.reply("ከ 10 ብር በላይ ያስገቡ።");
        ctx.session.amount = a; ctx.session.state = null;
        return ctx.reply(`መጠን: ${a} ብር. ዘዴ ይምረጡ:`, Markup.inlineKeyboard([[Markup.button.callback("TELEBIRR", "p_t"), Markup.button.callback("CBE", "p_c")]]));
    }
    if (ctx.session?.state === 'WAIT_W_AMT') {
        const a = parseInt(txt); const u = await User.findOne({ telegramId: uid });
        if (isNaN(a) || a < 50) return ctx.reply("ዝቅተኛ 50 ብር ነው ።");
        if (a > u.balance) return ctx.reply("ገንዘብ ለማውጣት በቂ Balance የለዎአትም።");
        ctx.reply(`✅ የገንዘብ ማውጣት ጥያቄዎ ለAdmin ተልኳል::`);
        if(ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `🚨 WITHDRAWAL\nUser: ${uid}\nAmt: ${a}`);
        ctx.session = null; return;
    }
    const r = parseBankSMS(txt);
    if (r) {
        const s = await VerifiedSMS.findOne({ refNumber: r.ref, isUsed: false });
        if (s) {
            s.isUsed = true; s.usedBy = uid; await s.save();
            const u = await User.findOneAndUpdate({ telegramId: uid }, { $inc: { balance: s.amount } }, { new: true });
            io.to(uid).emit('balance_update', u.balance); ctx.reply(`✅ Added ${s.amount} Birr!`);
        }
    }
});

bot.action('p_t', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 0922573939 (SEID) ${ctx.session.amount || 10} ይላኩ\n2. መልዕክቱን Past ያርጉ 👇`));
bot.action('p_c', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 1000102526418 (Acc) ${ctx.session.amount || 10} ያስገቡ\n2. መልዕክቱን Past ያርጉ 👇`));
bot.action('bal', async (ctx) => { const u = await User.findOne({ telegramId: ctx.from.id.toString() }); ctx.reply(`💰 Balance: ${u?.balance || 0} Birr`); });
bot.action('sup', (ctx) => ctx.reply(`🛠 Support: @sya9744 / @komodo27`));
bot.action('dep', (ctx) => { ctx.session = { state: 'WAIT_AMT' }; ctx.reply("ማስገባት የፈለጉትን የብር መጠን ያስገቡ:"); });
bot.action('w_start', (ctx) => { ctx.session = { state: 'WAIT_W_AMT' }; ctx.reply("ማውጣት የሚፈለጉትን የገንዘብ መጠን ያስገቡ:"); });

bot.launch();
const publicPath = path.resolve(__dirname, 'public');
app.use(express.static(publicPath));
app.get('*', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 live`));
