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
    refNumber: { type: String, unique: true },
    amount: Number,
    fullText: String,
    isUsed: { type: Boolean, default: false },
    usedBy: { type: String, default: null }, 
    createdAt: { type: Date, default: Date.now, expires: 172800 } 
}));

// --- 2. SMS API & PING (FOR ZEROGIC) ---
app.all('/api/incoming-sms', async (req, res) => {
    const incomingText = req.body.text || req.body.message || req.query.text || "";
    const data = parseBankSMS(incomingText);
    if (data) {
        try { await VerifiedSMS.create({ refNumber: data.ref, amount: data.amount, fullText: incomingText }); } catch (e) {}
    }
    res.status(200).send("OK");
});

app.get('/ping', (req, res) => {
    console.log("⏱ Ping Received - Keeping Awake");
    res.status(200).send("Awake");
});

function parseBankSMS(text) {
    if (!text) return null;
    const refMatch = text.match(/[A-Z0-9]{10,12}/);
    const amountMatch = text.match(/(?:Birr|ETB|amt|amount)[:\s]*?([0-9.]+)/i) || text.match(/([0-9.]+)\s*?Birr/i);
    return (refMatch && amountMatch) ? { ref: refMatch[0], amount: parseFloat(amountMatch[1]) } : null;
}

// --- 3. BINGO ENGINE (DETERMINISTIC & HIGH VARIANCE) ---
function generateServerCard(id) {
    const cardId = parseInt(id) || 1;
    let state = (cardId * 15485863) ^ 0x6D2B79F5; 
    const nextRng = () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
    };
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
    return ([0,1,2,3,4].map(i => card[i][i]).every(n => drawn.has(n)) || [0,1,2,3,4].map(i => card[i][4-i]).every(n => drawn.has(n)));
}

// --- 4. GAME STATE & LOOP ---
let gameState = { phase: 'SELECTION', phaseEndTime: Date.now() + 40000, timer: 40, drawnNumbers: [], pot: 0, winner: null, totalPlayers: 0, takenCards: [] };
let players = {}; let socketToUser = {};

setInterval(async () => {
    const now = Date.now();
    let timeLeft = Math.ceil((gameState.phaseEndTime - now) / 1000);
    if (timeLeft < 0) timeLeft = 0;
    gameState.timer = timeLeft;

    if (gameState.phase === 'SELECTION') {
        let total = 0; let allT = [];
        Object.values(players).forEach(p => { if (p.cards) { total += p.cards.length; allT.push(...p.cards); } });
        gameState.totalPlayers = total; gameState.pot = total * 10; gameState.takenCards = allT;

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

// --- 5. SOCKETS ---
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

    socket.on('get_leaderboard', async () => {
        const top = await User.find({ isRegistered: true }).sort({ totalPlayed: -1 }).limit(10);
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

// --- 6. BOT LOGIC (FULL PROFESSIONAL RESTORATION) ---
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

bot.telegram.setMyCommands([
    { command: 'start', description: 'Start' }, { command: 'register', description: 'Register' }, { command: 'play', description: 'Play' },
    { command: 'deposit', description: 'Deposit' }, { command: 'balance', description: 'Balance' }, { command: 'withdraw', description: 'Withdraw' },
    { command: 'transfer', description: 'Transfer' }, { command: 'instruction', description: 'Instruction' }, { command: 'support', description: 'Support' }
]);
bot.telegram.setChatMenuButton({ menuButton: { type: 'default' } });

const mainKeyboard = (isReg) => Markup.inlineKeyboard([
    isReg ? [Markup.button.webApp("Play 🎮", MINI_APP_URL), Markup.button.callback("Register 📝", "reg_prompt")] : [Markup.button.callback("Register 📝", "reg_prompt")],
    [Markup.button.callback("Check Balance 💵", "bal"), Markup.button.callback("Deposit 💰", "dep")],
    [Markup.button.callback("Contact Support...", "support_trigger"), Markup.button.callback("Instruction 📖", "instructions_trigger")],
    [Markup.button.callback("Transfer 🎁", "transfer"), Markup.button.callback("Withdraw 🤑", "withdraw_start")],
    [Markup.button.callback("Invite 🔗", "invite")]
]);

const contactKey = Markup.keyboard([[Markup.button.contactRequest("📞 Share contact")]]).resize().oneTime();
const supportHeader = `የሚያጋጥማቹ የክፍያ ችግር: \n @sya9744\n@Komodo27 ላይ ፃፉልን።`;

bot.start(async (ctx) => {
    const user = await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { username: ctx.from.first_name }, { upsert: true, new: true });
    if (!user.isRegistered) await ctx.reply("👋 Welcome! Please share your contact to earn 10 Birr Bonus.", contactKey);
    await ctx.reply(`👋 Welcome to Dil Bingo! Choose an Option below.`, mainKeyboard(user.isRegistered));
});

bot.on('contact', async (ctx) => {
    const existing = await User.findOne({ telegramId: ctx.from.id.toString() });
    let bonusText = "";
    if (existing && !existing.isRegistered) {
        await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { phoneNumber: ctx.message.contact.phone_number, isRegistered: true, $inc: { balance: 10 } });
        bonusText = "\n🎁 ለእርሶ የ 10 ብር የጅማሮ ቦነስ በWalletዎ ላይ ተጨምሯል!";
    } else {
        await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { phoneNumber: ctx.message.contact.phone_number, isRegistered: true });
    }
    ctx.reply(`✅ ተመዝግበዋል! አሁን መጫወት ይችላሉ።${bonusText}`, Markup.removeKeyboard());
    ctx.reply("Main Menu:", mainKeyboard(true));
});

bot.action('instructions_trigger', (ctx) => {
    ctx.answerCbQuery();
    const htmlText = `<b>📘 የቢንጎ ጨዋታ ህጎች</b>\n\n` +
    `<blockquote><b>🃏 መጫወቻ ካርድ</b>\n\n1. ጨዋታውን ለመጀመር ከሚመጣልን ከ1-300 የመጫወቻ ካርድ ውስጥ አንዱን እንመርጣለን።\n\n2. የመጫወቻ ካርዱ ላይ በቀይ ቀለም የተመረጡ ቁጥሮች የሚያሳዩት መጫወቻ ካርድ በሌላ ተጫዋች መመረጡን ነው።\n\n3. የመጫወቻ ካርድ ስንነካው ከታች በኩል ካርድ ቁጥሩ የሚይዘዉን መጫወቻ ካርድ ያሳየናል።\n\n4. ወደ ጨዋታው ለመግባት የምንፈልገዉን ካርድ ከመረጥን ለምዝገባ የተሰጠው ሰኮንድ ዜሮ ሲሆን ቀጥታ ወደ ጨዋታ ያስገባናል።</blockquote>\n\n` +
    `<blockquote><b>🎮 ጨዋታ</b>\n\n1. ወደ ጨዋታው ስንገባ በመረጥነው የካርድ ቁጥር መሰረት የመጫወቻ ካርድ እናገኛለን።\n\n2. ጨዋታው ሲጀምር የተለያዪ ቁጥሮች ከ1 እስከ 75 መጥራት ይጀምራል።\n\n3. የሚጠራው ቁጥር የኛ መጫወቻ ካርድ ውስጥ ካለ የተጠራውን ቁጥር ክሊክ በማረግ መምረጥ እንችላለን።\n\n4. የመረጥነውን ቁጥር ማጥፋት ከፈለግን መልሰን እራሱን ቁጥር ክሊክ በማረግ ማጥፋት እንችላለን።</blockquote>\n\n` +
    `<blockquote><b>🏆 አሸናፊ</b>\n\n1. ቁጥሮቹ ሲጠሩ ከመጫወቻ ካርዳችን ላይ እየመረጥን ወደጎን ወይም ወደታች ወይም ወደሁለቱም አግዳሚ ወይም አራቱን ማእዘናት ከመረጥን ወዲያውኑ ከታች በኩል <b>bingo</b> የሚለውን በመንካት ማሸነፍ እንችላለን።\n\n2. ወደጎን ወይም ወደታች ወይም ወደሁለቱም አግዳሚ ወይም አራቱን ማእዘናት ሳይጠሩ <b>bingo</b> የሚለውን ክሊክ ካደረግን ከጨዋታው እንታገዳለን።\n\n3. ሁለት ወይም ከዚያ በላይ ተጫዋቾች እኩል ቢያሸንፉ ደራሹ ለቁጥራቸው ይካፈላል።</blockquote>`;
    ctx.replyWithHTML(htmlText);
});

bot.action('dep', (ctx) => { ctx.answerCbQuery(); ctx.session = { state: 'WAIT_DEP_AMT' }; ctx.reply("ማስገባት የፈለጉትን የብር መጠን ከ 10 ብር ጀምሮ ያስገቡ።"); });

bot.action('withdraw_start', async (ctx) => {
    const u = await User.findOne({ telegramId: ctx.from.id.toString() });
    if (!u || u.balance < 50) return ctx.reply("ዝቅተኛ ማውጣት የሚቻለው 50 ብር ነው ።");
    ctx.session = { state: 'WAIT_W_AMT' }; ctx.reply("💰 ማውጣት የሚፈልጉትን የገንዘብ መጠን ያስገቡ ?");
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text; const uid = ctx.from.id.toString();
    if (ctx.session?.state === 'WAIT_DEP_AMT') {
        const amt = parseInt(text); if (isNaN(amt) || amt < 10) return ctx.reply("ከ 10 ብር በላይ ያስገቡ።");
        ctx.session.amount = amt; ctx.session.state = null;
        return ctx.reply(`መጠን: ${amt} ብር\nእባክዎ የክፍያ ዘዴ ይምረጡ:`, Markup.inlineKeyboard([[Markup.button.callback("TELEBIRR", "pay_tele"), Markup.button.callback("COMMERCIAL BANK", "pay_cbe")],[Markup.button.callback("ABYSSINIA", "pay_aby"), Markup.button.callback("CBE BIRR", "pay_cbebirr")]]));
    }
    if (ctx.session?.state === 'WAIT_W_AMT') {
        const amt = parseInt(text); const u = await User.findOne({ telegramId: uid });
        if (isNaN(amt) || amt < 50) return ctx.reply("ዝቅተኛ 50 ብር ነው ።");
        if (amt > u.balance) return ctx.reply("ገንዘብ ለማውጣት በቂ Balance የለዎአትም። እባክዎ Deposit በማድረግ ይጫወቱ።");
        ctx.session.w_amt = amt; ctx.session.state = 'WAIT_W_METH';
        return ctx.reply("💸 የሚፈልጉትን የክፍያ አማራጭ ይምረጡ:", Markup.inlineKeyboard([[Markup.button.callback("Telebirr", "w_meth_Telebirr")],[Markup.button.callback("CBE", "w_meth_CBE")],[Markup.button.callback("Abyssinia", "w_meth_Abyssinia")],[Markup.button.callback("❌ Cancel", "w_cancel")]]));
    }
    if (ctx.session?.state === 'WAIT_W_ID') { ctx.session.w_id = text; ctx.session.state = 'WAIT_W_NAME'; return ctx.reply("👤 እባክዎ የአካውንቱን ባለቤት ስም ያስገቡ::"); }
    if (ctx.session?.state === 'WAIT_W_NAME') {
        const { w_amt, method, w_id } = ctx.session; await User.findOneAndUpdate({ telegramId: uid }, { $inc: { balance: -w_amt } });
        ctx.reply(`✅ የገንዘብ ማውጣት ጥያቄዎ ለAdmin ተልኳል::`);
        if(ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `🚨 WITHDRAWAL\nUser: ${uid}\nAmt: ${w_amt}\nID: ${w_id}\nName: ${text}`);
        ctx.session = null; return;
    }
    const sms = parseBankSMS(text);
    if (sms) {
        const record = await VerifiedSMS.findOne({ refNumber: sms.ref, isUsed: false });
        if (record) {
            record.isUsed = true; record.usedBy = uid; await record.save();
            const u = await User.findOneAndUpdate({ telegramId: uid }, { $inc: { balance: record.amount } }, { new: true });
            io.to(uid).emit('balance_update', u.balance); ctx.reply(`✅ ${record.amount} ብር ገብቷል።`);
        }
    }
});

bot.action('pay_tele', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 0922573939 (SEID) ${ctx.session.amount || 10} ብር ይላኩ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('pay_cbe', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 1000102526418 (Acc) ${ctx.session.amount || 10} ብር ያስገቡ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('pay_aby', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 88472845 (Acc) ${ctx.session.amount || 10} ብር ያስገቡ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('pay_cbebirr', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 0922573939 (CBE BIRR) ${ctx.session.amount || 10} ብር ይላኩ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('support_trigger', (ctx) => ctx.reply(`🛠 Support:\n👉 @sya9744\n👉 @komodo27`));
bot.action('bal', async (ctx) => { const u = await User.findOne({ telegramId: ctx.from.id.toString() }); ctx.reply(`💰 Balance: ${u?.balance || 0} Birr`); });
bot.action(/w_meth_(.+)/, (ctx) => { const meth = ctx.match[1]; ctx.session.method = meth; ctx.session.state = 'WAIT_W_ID'; ctx.editMessageText(`🏦 ዘዴ: ${meth}\n👤 እባክዎ የስልክ/አካውንት ቁጥሮን ያስገቡ::`); });
bot.action('w_cancel', (ctx) => { ctx.session = null; ctx.editMessageText("❌ ተሰርዟል።"); });

bot.launch();

// --- 7. SERVE FRONTEND ---
const publicPath = path.resolve(__dirname, 'public');
app.use(express.static(publicPath));
app.get('*', (req, res) => {
    if (req.path.includes('.') && !req.path.endsWith('.html')) return res.status(404).end();
    res.sendFile(path.join(publicPath, 'index.html'));
});
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Live on ${PORT}`));
