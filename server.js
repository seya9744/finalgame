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
app.use(express.urlencoded({ extended: true }));

// --- 1. DATABASE MODELS ---
mongoose.connect(MONGODB_URI).then(() => console.log("✅ DB Connected"));

const User = mongoose.model('User', new mongoose.Schema({
    telegramId: { type: String, unique: true },
    username: String,
    phoneNumber: { type: String, default: "Not Registered" },
    balance: { type: Number, default: 0 },
    isRegistered: { type: Boolean, default: false }
}));

const VerifiedSMS = mongoose.model('VerifiedSMS', new mongoose.Schema({
    refNumber: { type: String, unique: true },
    amount: Number,
    fullText: String,
    isUsed: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, expires: 172800 } // Auto-delete after 2 days
}));

// --- 2. BINGO SERVER LOGIC ---
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
    card[2][2] = 0; // Star space
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

// --- 3. GAME STATE & LOOPS ---
let gameState = { phase: 'SELECTION', phaseEndTime: Date.now() + 40000, timer: 40, drawnNumbers: [], pot: 0, winner: null, totalPlayers: 0, takenCards: [] };
let players = {}; 
let socketToUser = {};

setInterval(async () => {
    const now = Date.now();
    let timeLeft = Math.ceil((gameState.phaseEndTime - now) / 1000);
    if (timeLeft < 0) timeLeft = 0;
    gameState.timer = timeLeft;

    if (gameState.phase === 'SELECTION') {
        let totalCards = 0;
        Object.values(players).forEach(p => { if (p.cards) totalCards += p.cards.length; });
        gameState.totalPlayers = totalCards;
        gameState.pot = totalCards * 10;

        if (timeLeft <= 0) {
            if (totalCards >= 2) {
                gameState.phase = 'GAMEPLAY';
                for (let tid in players) {
                    if (players[tid].cards?.length > 0) {
                        const cost = players[tid].cards.length * 10;
                        const u = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: -cost } }, { new: true });
                        if(u) io.to(tid).emit('balance_update', u.balance);
                    }
                }
            } else {
                gameState.phaseEndTime = Date.now() + 40000;
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

// Fast Drawing (2.5 Seconds)
setInterval(() => {
    if (gameState.phase === 'GAMEPLAY' && !gameState.winner && gameState.drawnNumbers.length < 75) {
        let n;
        do { n = Math.floor(Math.random() * 75) + 1; } while (gameState.drawnNumbers.includes(n));
        gameState.drawnNumbers.push(n);
        io.emit('number_drawn', gameState.drawnNumbers);
    }
}, 2500);

// --- 4. SMS AUTOMATION & CRON LOGIC ---

// Keep-Alive for Cron-job.org
app.get('/ping', (req, res) => res.status(200).send("Awake"));

// Bank SMS Parser
function parseBankSMS(text) {
    const refMatch = text.match(/[A-Z0-9]{10,12}/);
    const amountMatch = text.match(/(?:Birr|amt|amount|ETB)[:\s]*?([0-9.]+)/i) || text.match(/([0-9.]+)\s*?Birr/i);
    if (refMatch && amountMatch) {
        return { ref: refMatch[0], amount: parseFloat(amountMatch[1]) };
    }
    return null;
}

// SMS Receiver Webhook
app.post('/api/incoming-sms', async (req, res) => {
    const message = req.body.message || req.body.text || req.query.text;
    console.log("📩 SMS Received from phone app:", message);
    
    const data = parseBankSMS(message);
    if (data) {
        try {
            await VerifiedSMS.create({ refNumber: data.ref, amount: data.amount, fullText: message });
            console.log(`✅ SMS Data stored: ${data.ref}`);
            return res.status(200).send("OK");
        } catch (e) { return res.status(200).send("Duplicate"); }
    }
    res.status(400).send("No ref found");
});

// --- 5. SOCKETS ---
io.on('connection', (socket) => {
    socket.on('register_user', async (data) => {
        try {
            const urlParams = new URLSearchParams(data.initData);
            const user = JSON.parse(urlParams.get('user'));
            const tid = user.id.toString();
            socket.join(tid);
            socketToUser[socket.id] = tid;
            const u = await User.findOne({ telegramId: tid });
            if (u) {
                socket.emit('user_data', { balance: u.balance, phoneNumber: u.phoneNumber });
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
                if(u) io.to(tid).emit('balance_update', u.balance);
                gameState.phase = 'WINNER'; gameState.phaseEndTime = Date.now() + 7000; 
                io.emit('game_tick', gameState);
            }
        }
    });
});

// --- 6. BOT MENU & UI ---
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

const mainKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.webApp("Play 🎮", MINI_APP_URL), Markup.button.callback("Register 📝", "reg_prompt")],
    [Markup.button.callback("Check Balance 💵", "bal"), Markup.button.callback("Deposit 💰", "dep")],
    [Markup.button.callback("Contact Support...", "support"), Markup.button.callback("Instruction 📖", "rules")],
    [Markup.button.callback("Transfer 🎁", "transfer"), Markup.button.callback("Withdraw 🤑", "withdraw")],
    [Markup.button.callback("Invite 🔗", "invite")]
]);

const contactKey = Markup.keyboard([[Markup.button.contactRequest("📞 Share contact")]]).resize().oneTime();
const supportHeader = `የሚያጋጥማቹ የክፍያ ችግር: \n @sya9744\n@Komodo27 ላይ ፃፉልን።`;

bot.start(async (ctx) => {
    const user = await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { username: ctx.from.first_name }, { upsert: true, new: true });
    if (!user.isRegistered) await ctx.reply("Register to play.", contactKey);
    await ctx.reply(`👋 Welcome to Dil Bingo! Choose an Option below.`, mainKeyboard());
});

bot.action('dep', (ctx) => {
    ctx.answerCbQuery();
    ctx.session = ctx.session || {};
    ctx.session.state = 'WAIT_AMT';
    ctx.reply("ማስገባት የፈለጉትን የብር መጠን ከ 10 ብር ጀምሮ ያስገቡ።");
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text;

    if (ctx.session?.state === 'WAIT_AMT') {
        const amount = parseInt(text);
        if (isNaN(amount) || amount < 10) return ctx.reply("እባክዎን ከ 10 ብር በላይ ያስገቡ።");
        ctx.session.amount = amount;
        ctx.session.state = null;
        return ctx.reply(`የመረጡት መጠን: ${amount} ብር\nእባክዎ የክፍያ ዘዴ ይምረጡ:`, Markup.inlineKeyboard([
            [Markup.button.callback("TELEBIRR", "pay_tele"), Markup.button.callback("COMMERCIAL BANK", "pay_cbe")],
            [Markup.button.callback("ABYSSINIA", "pay_aby"), Markup.button.callback("CBE BIRR", "pay_cbebirr")]
        ]));
    }

    // Reference Code Verifier
    const data = parseBankSMS(text);
    if (data) {
        const smsRecord = await VerifiedSMS.findOne({ refNumber: data.ref, isUsed: false });
        if (smsRecord) {
            smsRecord.isUsed = true; await smsRecord.save();
            const u = await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { $inc: { balance: smsRecord.amount } }, { new: true });
            io.to(ctx.from.id.toString()).emit('balance_update', u.balance);
            return ctx.reply(`✅ ተረጋግጧል! ${smsRecord.amount} ብር ገብቷል።`);
        } else {
            return ctx.reply("❌ የደረሰኝ ቁጥሩ አልተገኘም ወይም ጥቅም ላይ ውሏል።");
        }
    }
});

// Bank Instructions
bot.action('pay_tele', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 0922573939 (SEID) ${ctx.session.amount || 10} ብር ይላኩ\n\n2. የደረሰኙን መልዕክት እዚህ ይላኩ 👇`));
bot.action('pay_cbe', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 1000102526418 (SEID) ${ctx.session.amount || 10} ብር ያስገቡ\n\n2. የደረሰኙን መልዕክት እዚህ ይላኩ 👇`));
bot.action('pay_aby', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 88472845 (Acc) ${ctx.session.amount || 10} ብር ያስገቡ\n\n2. የደረሰኙን መልዕክት እዚህ ይላኩ 👇`));
bot.action('pay_cbebirr', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 0922573939 (CBE BIRR) ${ctx.session.amount || 10} ብር ይላኩ\n\n2. የደረሰኙን መልዕክት እዚህ ይላኩ 👇`));

bot.on('contact', async (ctx) => {
    await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { phoneNumber: ctx.message.contact.phone_number, isRegistered: true });
    ctx.reply("✅ ተመዝግበዋል!", mainKeyboard());
});

bot.action('bal', async (ctx) => {
    const u = await User.findOne({ telegramId: ctx.from.id.toString() });
    ctx.reply(`💰 Balance: ${u?.balance || 0} Birr`);
});

bot.launch();

// --- 7. SERVE FRONTEND ---
const publicPath = path.resolve(__dirname, 'public');
app.use(express.static(publicPath));
app.get('*', (req, res) => {
    if (req.path.includes('.') && !req.path.endsWith('.html')) return res.status(404).end();
    res.sendFile(path.join(publicPath, 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on ${PORT}`));
