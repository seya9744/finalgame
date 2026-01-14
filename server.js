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

// --- BINGO ENGINE (HIGH ENTROPY FIX) ---
function generateServerCard(id) {
    const cardId = parseInt(id) || 1;
    // Using a much larger prime and bit-shifting to ensure cards 1, 2, 3 are totally different
    let state = (cardId * 2654435761) ^ (cardId << 13); 
    const nextRng = () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
    };

    let columns = [];
    const ranges = [[1,15],[16,30],[31,45],[46,60],[61,75]];
    for(let i=0; i<5; i++) {
        let col = [];
        let [min, max] = ranges[i];
        let pool = Array.from({length: max-min+1}, (_, k) => k + min);
        for(let j=0; j<5; j++) {
            let idx = Math.floor(nextRng() * pool.length);
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
    const drawn = new Set(drawnNumbers); drawn.add(0);
    for (let i = 0; i < 5; i++) {
        if (card[i].every(n => drawn.has(n))) return true;
        if ([0,1,2,3,4].map(r => card[r][i]).every(n => drawn.has(n))) return true;
    }
    return ([0,1,2,3,4].map(i => card[i][i]).every(n => drawn.has(n)) || [0,1,2,3,4].map(i => card[i][4-i]).every(n => drawn.has(n)));
}

// --- GAME STATE ---
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

io.on('connection', (socket) => {
    socket.on('register_user', async (data) => {
        try {
            const urlParams = new URLSearchParams(data.initData); const user = JSON.parse(urlParams.get('user')); const tid = user.id.toString();
            socket.join(tid); socketToUser[socket.id] = tid;
            const u = await User.findOne({ telegramId: tid });
            if (u) {
                if (!u.isRegistered) return socket.emit('error_message', "እባክዎ መጀመሪያ Register ያድርጉ!");
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
            
            // 🛠️ FIX 4: Removed immediate broadcast
            // We rely on the setInterval loop (every 1s) to update clients.
            // This prevents "flicker storm" when multiple people click fast.
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
                const u = await User.findOne({ telegramId: tid });
                io.to(tid).emit('balance_update', u.balance);
                gameState.phase = 'WINNER'; gameState.phaseEndTime = Date.now() + 7000; io.emit('game_tick', gameState);
            }
        }
    });
});

const bot = new Telegraf(BOT_TOKEN);
bot.use(session());
bot.telegram.setMyCommands([{ command: 'start', description: 'Start' }, { command: 'play', description: 'Play' }, { command: 'balance', description: 'Balance' }, { command: 'deposit', description: 'Deposit' }, { command: 'withdraw', description: 'Withdraw' }]);
bot.telegram.setChatMenuButton({ menuButton: { type: 'default' } });

const mainKeyboard = (isReg) => {
    const r = [ isReg ? [Markup.button.webApp("Play 🎮", MINI_APP_URL), Markup.button.callback("Register 📝", "reg")] : [Markup.button.callback("Register 📝", "reg")] ];
    r.push([Markup.button.callback("Check Balance 💵", "bal"), Markup.button.callback("Deposit 💰", "dep")], [Markup.button.callback("Contact Support...", "sup"), Markup.button.callback("Instruction 📖", "rule")], [Markup.button.callback("Withdraw 🤑", "w_start")]);
    return Markup.inlineKeyboard(r);
};

const supportHeader = `የሚያጋጥማቹ የክፍያ ችግር: \n @sya9744\n@Komodo27 ላይ ፃፉልን።`;

bot.start(async (ctx) => {
    const u = await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { username: ctx.from.first_name }, { upsert: true, new: true });
    if (!u.isRegistered) await ctx.reply("Welcome! Share contact for 10 Birr Bonus.", Markup.keyboard([[Markup.button.contactRequest("📞 Share contact")]]).resize().oneTime());
    await ctx.reply(`👋 Welcome to Dil Bingo! Choose an Option below.`, mainKeyboard(u.isRegistered));
});

bot.on('contact', async (ctx) => {
    const ex = await User.findOne({ telegramId: ctx.from.id.toString() });
    let msg = "";
    if (ex && !ex.isRegistered) {
        await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { phoneNumber: ctx.message.contact.phone_number, isRegistered: true, $inc: { balance: 10 } });
        msg = "\n🎁 ለእርሶ የ 10 ብር ቦነስ ተጨምሯል!";
    }
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
            io.to(uid).emit('balance_update', u.balance); ctx.reply(`✅ ${s.amount} ብር ገብቷል።`);
        }
    }
});

bot.action('p_t', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 0922573939 (SEID) ${ctx.session.amount || 10} ይላኩ\n2. መልዕክቱን Past ያርጉ 👇`));
bot.action('p_c', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 1000102526418 (Acc) ${ctx.session.amount || 10} ያስገቡ\n2. መልዕክቱን Past ያርጉ 👇`));

bot.launch();
app.all('/api/incoming-sms', async (req, res) => { res.send("OK"); });
app.get('/ping', (req, res) => res.send("OK"));
const publicPath = path.resolve(__dirname, 'public');
app.use(express.static(publicPath));
app.get('*', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 live`));
