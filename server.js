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

// --- 2. THE NEW HIGH-VARIANCE GENERATOR ---
function generateServerCard(id) {
    const cardId = parseInt(id) || 1;
    // We apply a massive multiplier and a prime salt to spread the random numbers 
    let state = (cardId * 15485863) ^ 0x6D2B79F5; 
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
    card[2][2] = 0; // Middle Star
    return card;
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

// --- 3. GAME STATE ---
// Requirement met: "TakenCards" list removed to stop flickering and hide other player info
let gameState = { phase: 'SELECTION', phaseEndTime: Date.now() + 40000, timer: 40, drawnNumbers: [], pot: 0, winner: null, totalPlayers: 0 };
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
                        await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: -(players[tid].cards.length * 10) } });
                        const u = await User.findOne({ telegramId: tid });
                        if(u) io.to(tid).emit('balance_update', u.balance);
                    }
                }
            } else { gameState.phaseEndTime = Date.now() + 40000; }
        }
    }
    if (gameState.phase === 'WINNER' && timeLeft <= 0) {
        gameState = { phase: 'SELECTION', phaseEndTime: Date.now() + 40000, timer: 40, drawnNumbers: [], pot: 0, winner: null, totalPlayers: 0 };
        for (let tid in players) players[tid].cards = [];
    }
    io.emit('game_tick', gameState);
}, 1000);

setInterval(() => {
    if (gameState.phase === 'GAMEPLAY' && !gameState.winner && gameState.drawnNumbers.length < 75) {
        let n; do { n = Math.floor(Math.random() * 75) + 1; } while (gameState.drawnNumbers.includes(n));
        gameState.drawnNumbers.push(n); io.emit('number_drawn', gameState.drawnNumbers);
    }
}, 2500);

// --- 4. SOCKETS ---
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
            // No more io.emit here to prevent other players seeing cards and flickering
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
    // Stats fetchers preserved
    socket.on('get_leaderboard', async () => {
        const top = await User.find({ isRegistered: true }).sort({ totalPlayed: -1 }).limit(10);
        socket.emit('leaderboard_data', top);
    });
    socket.on('get_history', async (data) => {
        try {
            const urlParams = new URLSearchParams(data.initData); const user = JSON.parse(urlParams.get('user'));
            const hist = await GameRecord.find({ telegramId: user.id.toString() }).sort({ date: -1 }).limit(10);
            socket.emit('history_data', hist);
        } catch (e) {}
    });
});

// --- 5. BOT MENU (FULL RESTORATION) ---
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());
bot.telegram.setMyCommands([{ command: 'start', description: 'Start' }, { command: 'play', description: 'Play' }, { command: 'balance', description: 'Balance' }, { command: 'withdraw', description: 'Withdraw' }]);
bot.telegram.setChatMenuButton({ menuButton: { type: 'default' } });

const mainKey = (isR) => {
    const rows = [ isR ? [Markup.button.webApp("Play 🎮", MINI_APP_URL), Markup.button.callback("Register 📝", "reg")] : [Markup.button.callback("Register 📝", "reg")] ];
    rows.push([Markup.button.callback("Check Balance 💵", "bal"), Markup.button.callback("Deposit 💰", "dep")], [Markup.button.callback("Contact Support...", "sup"), Markup.button.callback("Instruction 📖", "rule")], [Markup.button.callback("Withdraw 🤑", "w_start")], [Markup.button.callback("Invite 🔗", "inv")]);
    return Markup.inlineKeyboard(rows);
};

const supportHeader = `የሚያጋጥማቹ የክፍያ ችግር: \n @sya9744\n@Komodo27 ላይ ፃፉልን።`;

bot.start(async (ctx) => {
    const u = await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { username: ctx.from.first_name }, { upsert: true, new: true });
    if (!u.isRegistered) await ctx.reply("Welcome! Share your contact for a 10 Birr Bonus.", Markup.keyboard([[Markup.button.contactRequest("📞 Share contact")]]).resize().oneTime());
    ctx.reply(`👋 Welcome to Dil Bingo! Choose below:`, mainKey(u.isRegistered));
});

bot.on('contact', async (ctx) => {
    const ex = await User.findOne({ telegramId: ctx.from.id.toString() });
    let bonusMsg = "";
    if (ex && !ex.isRegistered) {
        await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { phoneNumber: ctx.message.contact.phone_number, isRegistered: true, $inc: { balance: 10 } });
        bonusMsg = "\n🎁 ለእርሶ የ 10 ብር የጅማሮ ቦነስ በWalletዎ ላይ ተጨምሯል!";
    } else { await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { phoneNumber: ctx.message.contact.phone_number, isRegistered: true }); }
    ctx.reply(`✅ ተመዝግበዋል!${bonusMsg}`, Markup.removeKeyboard());
    ctx.reply("Main Menu:", mainKey(true));
});

bot.action('rule', (ctx) => {
    const rulesText = `<b>📘 የቢንጎ ጨዋታ ህጎች</b>\n\n<blockquote><b>🃏 መጫወቻ ካርድ</b>\n\n1. ጨዋታውን ለመጀመር ከሚመጣልን ከ1-300 የመጫወቻ ካርድ ውስጥ አንዱን እንመርጣለን።\n2. ቀይ ቀለም የሚያሳዩት በሌላ ተጫዋች መመረጡን ነው።\n3. የመጫወቻ ካርድ ስንነካ Preview ያሳየናል።</blockquote>\n\n<blockquote><b>🎮 ጨዋታ</b>\n1. ቁጥሮች ከ1-75 ይጠራሉ::\n2. ካርዶ ላይ ካለ ክሊክ በማረግ ይምረጡ::</blockquote>`;
    ctx.replyWithHTML(rulesText);
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text; const uid = ctx.from.id.toString();
    if (ctx.session?.state === 'WAIT_AMT') {
        const amt = parseInt(text); if (isNaN(amt) || amt < 10) return ctx.reply("ከ 10 ብር በላይ ያስገቡ።");
        ctx.session.amount = amt; ctx.session.state = null;
        return ctx.reply(`መጠን: ${amt} ብር. ዘዴ ይምረጡ:`, Markup.inlineKeyboard([[Markup.button.callback("TELEBIRR", "p_tele"), Markup.button.callback("CBE", "p_cbe")]]));
    }
    if (ctx.session?.state === 'WAIT_W_AMT') {
        const amt = parseInt(text); const u = await User.findOne({ telegramId: uid });
        if (isNaN(amt) || amt < 50) return ctx.reply("ዝቅተኛ ማውጣት የሚቻለውየገንዘብ መጠን 50 ብር ነው ።");
        if (amt > u.balance) return ctx.reply("ገንዘብ ለማውጣት በቂ Balance የለዎአትም::");
        ctx.reply("✅ የገንዘብ ማውጣት ጥያቄዎ ተልኳል::");
        if(ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `WITHDRAWAL: ${uid} - ${amt} Birr`);
        ctx.session = null; return;
    }
    const r = parseBankSMS(text);
    if (r) {
        const s = await VerifiedSMS.findOne({ refNumber: r.ref, isUsed: false });
        if (s) {
            s.isUsed = true; s.usedBy = uid; await s.save();
            const u = await User.findOneAndUpdate({ telegramId: uid }, { $inc: { balance: s.amount } }, { new: true });
            io.to(uid).emit('balance_update', u.balance); ctx.reply(`✅ Added ${s.amount} Birr!`);
        }
    }
});

bot.action('p_tele', (ctx) => ctx.reply(`${supportHeader}\n\nወደ 0922573939 (SEID) ${ctx.session.amount || 10} ይላኩና መልዕክቱን Past ያርጉ 👇`));
bot.action('p_cbe', (ctx) => ctx.reply(`${supportHeader}\n\nወደ 1000102526418 (Acc) ${ctx.session.amount || 10} ያስገቡና መልዕክቱን Past ያርጉ 👇`));
bot.action('sup', (ctx) => ctx.reply("Support: @sya9744 @komodo27"));
bot.action('dep', (ctx) => { ctx.session = { state: 'WAIT_AMT' }; ctx.reply("የብር መጠን ያስገቡ:"); });
bot.action('w_start', (ctx) => { ctx.session = { state: 'WAIT_W_AMT' }; ctx.reply("የገንዘብ መጠን ያስገቡ:"); });

bot.launch();

// Webhook & SPA routing
app.all('/api/incoming-sms', async (req, res) => { res.send("OK"); });
app.get('/ping', (req, res) => res.send("Awake"));
app.use(express.static(path.resolve(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.resolve(__dirname, 'public', 'index.html')));
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 live on ${PORT}`));
