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
    isRegistered: { type: Boolean, default: false }
}));

const VerifiedSMS = mongoose.model('VerifiedSMS', new mongoose.Schema({
    refNumber: { type: String, unique: true },
    amount: Number,
    fullText: String,
    isUsed: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, expires: 172800 } 
}));

// --- 2. SMS API (UNIVERSAL) ---
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
    if (refMatch && amountMatch) return { ref: refMatch[0], amount: parseFloat(amountMatch[1]) };
    return null;
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
                        const u = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: -cost } }, { new: true });
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
                // BLOCK ACCESS IF NOT REGISTERED
                if (!u.isRegistered) return socket.emit('error_message', "መጀመሪያ በBot ውስጥ ስልክዎን Share በማድረግ ይመዝገቡ!");

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
                gameState.phase = 'WINNER'; gameState.phaseEndTime = Date.now() + 7000; io.emit('game_tick', gameState);
            }
        }
    });
});

// --- 6. BOT LOGIC (MENU & BANKING) ---
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

bot.telegram.setMyCommands([
    { command: 'start', description: 'Start' },
    { command: 'register', description: 'Register' },
    { command: 'play', description: 'Play' },
    { command: 'deposit', description: 'Deposit' },
    { command: 'balance', description: 'Balance' },
    { command: 'withdraw', description: 'Withdraw' },
    { command: 'transfer', description: 'Transfer' },
    { command: 'convert', description: 'Convert coin' },
    { command: 'invite', description: 'Invite' },
    { command: 'instruction', description: 'Instruction' },
    { command: 'support', description: 'Support' }
]);
bot.telegram.setChatMenuButton({ menuButton: { type: 'default' } });

// DYNAMIC KEYBOARD: ONLY SHOWS PLAY IF REGISTERED
const mainKeyboard = (isRegistered) => {
    const rows = [];
    if (isRegistered) {
        rows.push([Markup.button.webApp("Play 🎮", MINI_APP_URL), Markup.button.callback("Register 📝", "reg_prompt")]);
    } else {
        rows.push([Markup.button.callback("Register 📝", "reg_prompt")]);
    }
    rows.push([Markup.button.callback("Check Balance 💵", "bal"), Markup.button.callback("Deposit 💰", "dep")]);
    rows.push([Markup.button.callback("Contact Support...", "support_trigger"), Markup.button.callback("Instruction 📖", "instructions_trigger")]);
    rows.push([Markup.button.callback("Transfer 🎁", "transfer"), Markup.button.callback("Withdraw 🤑", "withdraw_start")]);
    rows.push([Markup.button.callback("Invite 🔗", "invite")]);
    return Markup.inlineKeyboard(rows);
};

const withdrawMethods = Markup.inlineKeyboard([
    [Markup.button.callback("Telebirr", "w_meth_Telebirr")],
    [Markup.button.callback("Commercial Bank", "w_meth_CBE")],
    [Markup.button.callback("Abyssinia Bank", "w_meth_Abyssinia")],
    [Markup.button.callback("CBE Birr", "w_meth_CBEBirr")],
    [Markup.button.callback("❌ Cancel", "w_cancel")]
]);

const contactKey = Markup.keyboard([[Markup.button.contactRequest("📞 Share contact")]]).resize().oneTime();
const supportHeader = `የሚያጋጥማቹ የክፍያ ችግር: \n @sya9744\n@Komodo27 ላይ ፃፉልን።`;

bot.start(async (ctx) => {
    const user = await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { username: ctx.from.first_name }, { upsert: true, new: true });
    if (!user.isRegistered) await ctx.reply("👋 Welcome! Please share your contact to earn 10 Birr Bonus and unlock the game.", contactKey);
    await ctx.reply(`👋 Welcome to Dil Bingo! Choose an Option below.`, mainKeyboard(user.isRegistered));
});

bot.command('register', (ctx) => ctx.reply("እባክዎ ለመመዝገብ ከታች ያለውን 'Share contact' የሚለውን ይጫኑ::", contactKey));

bot.command('play', async (ctx) => {
    const u = await User.findOne({ telegramId: ctx.from.id.toString() });
    if (!u.isRegistered) return ctx.reply("መጀመሪያ መመዝገብ አለብዎት!", contactKey);
    ctx.reply("መጫወት ለመጀመር Play የሚለውን ይጫኑ:", Markup.inlineKeyboard([[Markup.button.webApp("Play 🎮", MINI_APP_URL)]]));
});

bot.command('deposit', (ctx) => { ctx.session = { state: 'WAIT_AMT' }; ctx.reply("ማስገባት የፈለጉትን የብር መጠን ከ 10 ብር ጀምሮ ያስገቡ።"); });
bot.command('balance', async (ctx) => { const u = await User.findOne({ telegramId: ctx.from.id.toString() }); ctx.reply(`💰 Balance: ${u?.balance || 0} Birr`); });
bot.command('withdraw', async (ctx) => {
    const u = await User.findOne({ telegramId: ctx.from.id.toString() });
    if (!u || u.balance < 50) return ctx.reply("ዝቅተኛ ማውጣት የሚቻለውየገንዘብ መጠን 50 ብር ነው ።");
    ctx.session = { state: 'WAIT_W_AMT' }; ctx.reply("💰 ማውጣት የሚፈልጉትን የገንዘብ መጠን ያስገቡ ?");
});
bot.command('instruction', (ctx) => sendBeautifiedRules(ctx));
bot.command('support', (ctx) => ctx.reply(`🛠 Support:\n👉 @sya9744\n👉 @komodo27`));

// --- BUTTON ACTIONS ---
bot.action('support_trigger', (ctx) => { ctx.answerCbQuery(); ctx.reply(`🛠 Support:\n\nIf you need help, contact us here:\n👉 @sya9744\n👉 @komodo27`); });
const sendBeautifiedRules = (ctx) => {
    const htmlText = `<b>📘 የቢንጎ ጨዋታ ህጎች</b>\n\n` +
    `<blockquote><b>🃏 መጫወቻ ካርድ</b>\n\n1. ጨዋታውን ለመጀመር ከሚመጣልን ከ1-300 የመጫወቻ ካርድ ውስጥ አንዱን እንመርጣለን።\n\n2. የመጫወቻ ካርዱ ላይ በቀይ ቀለም የተመረጡ ቁጥሮች የሚያሳዩት መጫወቻ ካርድ በሌላ ተጫዋች መመረጡን ነው።\n\n3. የመጫወቻ ካርድ ስንነካው Preview ያሳየናል።\n\n4. ምዝገባ ሲያልቅ ወደ ጨዋታ ያስገባናል።</blockquote>\n\n` +
    `<blockquote><b>🎮 ጨዋታ</b>\n\n1. ቁጥሮች ከ1 እስከ 75 መጥራት ይጀምራል።\n\n2. ካርዶ ላይ ካለ ክሊክ በማረግ ይምረጡ።</blockquote>\n\n` +
    `<blockquote><b>🏆 አሸናፊ</b>\n\n1. ቁጥሮቹ ሲጠሩ ከመጫወቻ ካርዳችን ላይ እየመረጥን ወደጎን ወይም ወደታች ወይም ወደሁለቱም አግዳሚ ወይም አራቱን ማእዘናት ከመረጥን ወዲያውኑ ከታች በኩል <b>bingo</b> የሚለውን በመንካት ማሸነፍ እንችላለን።\n\n2. ወደጎን ወይም ወደታች ወይም ወደሁለቱም አግዳሚ ወይም አራቱን ማእዘናት ሳይጠሩ <b>bingo</b> የሚለውን ክሊክ ካደረግን ከጨዋታው እንታገዳለን።\n\n3. ሁለት ወይም ከዚያ በላይ ተጫዋቾች እኩል ቢያሸንፉ ደራሹ ለቁጥራቸው ይካፈላል።</blockquote>`;
    return ctx.replyWithHTML(htmlText);
};
bot.action('instructions_trigger', (ctx) => { ctx.answerCbQuery(); sendBeautifiedRules(ctx); });
bot.action('dep', (ctx) => { ctx.answerCbQuery(); ctx.session = { state: 'WAIT_AMT' }; ctx.reply("ማስገባት የፈለጉትን የብር መጠን ከ 10 ብር ጀምሮ ያስገቡ።"); });
bot.action('withdraw_start', async (ctx) => {
    const u = await User.findOne({ telegramId: ctx.from.id.toString() });
    if (!u || u.balance < 50) return ctx.reply("ዝቅተኛ ማውጣት የሚቻለውየገንዘብ መጠን 50 ብር ነው ።");
    ctx.session = { state: 'WAIT_W_AMT' }; ctx.reply("💰 ማውጣት የሚፈልጉትን የገንዘብ መጠን ያስገቡ ?");
});
bot.action(/w_meth_(.+)/, (ctx) => {
    const meth = ctx.match[1]; ctx.session.method = meth; ctx.session.state = 'WAIT_W_ID';
    const prompt = (meth === 'CBE' || meth === 'Abyssinia') ? "እባክዎ የአካውንት ቁጥሮን ያስገቡ::" : "እባክዎ የስልክ ቁጥሮን ያስገቡ::";
    ctx.editMessageText(`🏦 ዘዴ: ${meth}\n👤 ${prompt}`);
});
bot.action('w_cancel', (ctx) => { ctx.session = null; ctx.editMessageText("❌ ተሰርዟል።"); });

// --- TEXT HANDLER ---
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const uid = ctx.from.id.toString();

    if (ctx.session?.state === 'WAIT_AMT') {
        const amt = parseInt(text); if (isNaN(amt) || amt < 10) return ctx.reply("ከ 10 ብር በላይ ያስገቡ።");
        ctx.session.amount = amt; ctx.session.state = null;
        return ctx.reply(`መጠን: ${amt} ብር\nእባክዎ የክፍያ ዘዴ ይምረጡ:`, Markup.inlineKeyboard([[Markup.button.callback("TELEBIRR", "pay_tele"), Markup.button.callback("COMMERCIAL BANK", "pay_cbe")],[Markup.button.callback("ABYSSINIA", "pay_aby"), Markup.button.callback("CBE BIRR", "pay_cbebirr")]]));
    }
    if (ctx.session?.state === 'WAIT_W_AMT') {
        const amt = parseInt(text); const u = await User.findOne({ telegramId: uid });
        if (isNaN(amt) || amt < 50) return ctx.reply("ዝቅተኛ ማውጣት የሚቻለውየገንዘብ መጠን 50 ብር ነው ።");
        if (amt > u.balance) return ctx.reply("ገንዘብ ለማውጣት በቂ Balance የለዎአትም። እባክዎ Deposit በማድረግ ይጫወቱ።");
        ctx.session.w_amt = amt; ctx.session.state = 'WAIT_W_METH';
        return ctx.reply("ዘዴ ይምረጡ:", withdrawMethods);
    }
    if (ctx.session?.state === 'WAIT_W_ID') { ctx.session.w_id = text; ctx.session.state = 'WAIT_W_NAME'; return ctx.reply("👤 እባክዎ የአካውንቱን ባለቤት ስም ያስገቡ::"); }
    if (ctx.session?.state === 'WAIT_W_NAME') {
        const { w_amt, method, w_id } = ctx.session;
        await User.findOneAndUpdate({ telegramId: uid }, { $inc: { balance: -w_amt } });
        ctx.reply(`✅ የገንዘብ ማውጣት ጥያቄዎ ለAdmin ተልኳል::\nመጠን: ${w_amt} ብር\nዘዴ: ${method}\nID: ${w_id}\nስም: ${text}`);
        if(ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `🚨 WITHDRAWAL REQUEST\nUser: ${uid}\nAmt: ${w_amt}\nMeth: ${method}\nID: ${w_id}\nName: ${text}`);
        ctx.session = null; return;
    }
    const sms = parseBankSMS(text);
    if (sms) {
        const record = await VerifiedSMS.findOne({ refNumber: sms.ref, isUsed: false });
        if (record) {
            record.isUsed = true; await record.save();
            const u = await User.findOneAndUpdate({ telegramId: uid }, { $inc: { balance: record.amount } }, { new: true });
            io.to(uid).emit('balance_update', u.balance); ctx.reply(`✅ ${record.amount} ብር ገብቷል።`);
        }
    }
});

// REGISTER & WELCOME BONUS LOGIC
bot.on('contact', async (ctx) => {
    const existingUser = await User.findOne({ telegramId: ctx.from.id.toString() });
    let bonusText = "";

    // If it's a new registration
    if (existingUser && !existingUser.isRegistered) {
        await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { 
            phoneNumber: ctx.message.contact.phone_number, 
            isRegistered: true,
            $inc: { balance: 10 } // 10 BIRR BONUS
        });
        bonusText = "\n🎁 ለእርሶ የ 10 ብር የጅማሮ ቦነስ በWalletዎ ላይ ተጨምሯል!";
    } else {
        await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { phoneNumber: ctx.message.contact.phone_number, isRegistered: true });
    }

    ctx.reply(`✅ ተመዝግበዋል! አሁን መጫወት ይችላሉ።${bonusText}`, Markup.removeKeyboard());
    ctx.reply("Main Menu:", mainKeyboard(true));
});

bot.action('pay_tele', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 0922573939 (SEID) ${ctx.session.amount || 10} ብር ይላኩ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('pay_cbe', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 1000102526418 (Acc) ${ctx.session.amount || 10} ብር ያስገቡ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('pay_aby', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 88472845 (Acc) ${ctx.session.amount || 10} ብር ያስገቡ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('pay_cbebirr', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 0922573939 (CBE BIRR) ${ctx.session.amount || 10} ብር ይላኩ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('bal', async (ctx) => { const u = await User.findOne({ telegramId: ctx.from.id.toString() }); ctx.reply(`💰 Balance: ${u?.balance || 0} Birr`); });

bot.launch();

// --- 7. SERVE FRONTEND ---
const publicPath = path.resolve(__dirname, 'public');
app.use(express.static(publicPath));
app.get('*', (req, res) => {
    if (req.path.includes('.') && !req.path.endsWith('.html')) return res.status(404).end();
    res.sendFile(path.join(publicPath, 'index.html'));
});
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Live on ${PORT}`));require('dotenv').config();
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
    isRegistered: { type: Boolean, default: false }
}));

const VerifiedSMS = mongoose.model('VerifiedSMS', new mongoose.Schema({
    refNumber: { type: String, unique: true },
    amount: Number,
    fullText: String,
    isUsed: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, expires: 172800 } 
}));

// --- 2. SMS API (UNIVERSAL) ---
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
    if (refMatch && amountMatch) return { ref: refMatch[0], amount: parseFloat(amountMatch[1]) };
    return null;
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
                        const u = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: -cost } }, { new: true });
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
                // BLOCK ACCESS IF NOT REGISTERED
                if (!u.isRegistered) return socket.emit('error_message', "መጀመሪያ በBot ውስጥ ስልክዎን Share በማድረግ ይመዝገቡ!");

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
                gameState.phase = 'WINNER'; gameState.phaseEndTime = Date.now() + 7000; io.emit('game_tick', gameState);
            }
        }
    });
});

// --- 6. BOT LOGIC (MENU & BANKING) ---
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

bot.telegram.setMyCommands([
    { command: 'start', description: 'Start' },
    { command: 'register', description: 'Register' },
    { command: 'play', description: 'Play' },
    { command: 'deposit', description: 'Deposit' },
    { command: 'balance', description: 'Balance' },
    { command: 'withdraw', description: 'Withdraw' },
    { command: 'transfer', description: 'Transfer' },
    { command: 'convert', description: 'Convert coin' },
    { command: 'invite', description: 'Invite' },
    { command: 'instruction', description: 'Instruction' },
    { command: 'support', description: 'Support' }
]);
bot.telegram.setChatMenuButton({ menuButton: { type: 'default' } });

// DYNAMIC KEYBOARD: ONLY SHOWS PLAY IF REGISTERED
const mainKeyboard = (isRegistered) => {
    const rows = [];
    if (isRegistered) {
        rows.push([Markup.button.webApp("Play 🎮", MINI_APP_URL), Markup.button.callback("Register 📝", "reg_prompt")]);
    } else {
        rows.push([Markup.button.callback("Register 📝", "reg_prompt")]);
    }
    rows.push([Markup.button.callback("Check Balance 💵", "bal"), Markup.button.callback("Deposit 💰", "dep")]);
    rows.push([Markup.button.callback("Contact Support...", "support_trigger"), Markup.button.callback("Instruction 📖", "instructions_trigger")]);
    rows.push([Markup.button.callback("Transfer 🎁", "transfer"), Markup.button.callback("Withdraw 🤑", "withdraw_start")]);
    rows.push([Markup.button.callback("Invite 🔗", "invite")]);
    return Markup.inlineKeyboard(rows);
};

const withdrawMethods = Markup.inlineKeyboard([
    [Markup.button.callback("Telebirr", "w_meth_Telebirr")],
    [Markup.button.callback("Commercial Bank", "w_meth_CBE")],
    [Markup.button.callback("Abyssinia Bank", "w_meth_Abyssinia")],
    [Markup.button.callback("CBE Birr", "w_meth_CBEBirr")],
    [Markup.button.callback("❌ Cancel", "w_cancel")]
]);

const contactKey = Markup.keyboard([[Markup.button.contactRequest("📞 Share contact")]]).resize().oneTime();
const supportHeader = `የሚያጋጥማቹ የክፍያ ችግር: \n @sya9744\n@Komodo27 ላይ ፃፉልን።`;

bot.start(async (ctx) => {
    const user = await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { username: ctx.from.first_name }, { upsert: true, new: true });
    if (!user.isRegistered) await ctx.reply("👋 Welcome! Please share your contact to earn 10 Birr Bonus and unlock the game.", contactKey);
    await ctx.reply(`👋 Welcome to Dil Bingo! Choose an Option below.`, mainKeyboard(user.isRegistered));
});

bot.command('register', (ctx) => ctx.reply("እባክዎ ለመመዝገብ ከታች ያለውን 'Share contact' የሚለውን ይጫኑ::", contactKey));

bot.command('play', async (ctx) => {
    const u = await User.findOne({ telegramId: ctx.from.id.toString() });
    if (!u.isRegistered) return ctx.reply("መጀመሪያ መመዝገብ አለብዎት!", contactKey);
    ctx.reply("መጫወት ለመጀመር Play የሚለውን ይጫኑ:", Markup.inlineKeyboard([[Markup.button.webApp("Play 🎮", MINI_APP_URL)]]));
});

bot.command('deposit', (ctx) => { ctx.session = { state: 'WAIT_AMT' }; ctx.reply("ማስገባት የፈለጉትን የብር መጠን ከ 10 ብር ጀምሮ ያስገቡ።"); });
bot.command('balance', async (ctx) => { const u = await User.findOne({ telegramId: ctx.from.id.toString() }); ctx.reply(`💰 Balance: ${u?.balance || 0} Birr`); });
bot.command('withdraw', async (ctx) => {
    const u = await User.findOne({ telegramId: ctx.from.id.toString() });
    if (!u || u.balance < 50) return ctx.reply("ዝቅተኛ ማውጣት የሚቻለውየገንዘብ መጠን 50 ብር ነው ።");
    ctx.session = { state: 'WAIT_W_AMT' }; ctx.reply("💰 ማውጣት የሚፈልጉትን የገንዘብ መጠን ያስገቡ ?");
});
bot.command('instruction', (ctx) => sendBeautifiedRules(ctx));
bot.command('support', (ctx) => ctx.reply(`🛠 Support:\n👉 @sya9744\n👉 @komodo27`));

// --- BUTTON ACTIONS ---
bot.action('support_trigger', (ctx) => { ctx.answerCbQuery(); ctx.reply(`🛠 Support:\n\nIf you need help, contact us here:\n👉 @sya9744\n👉 @komodo27`); });
const sendBeautifiedRules = (ctx) => {
    const htmlText = `<b>📘 የቢንጎ ጨዋታ ህጎች</b>\n\n` +
    `<blockquote><b>🃏 መጫወቻ ካርድ</b>\n\n1. ጨዋታውን ለመጀመር ከሚመጣልን ከ1-300 የመጫወቻ ካርድ ውስጥ አንዱን እንመርጣለን።\n\n2. የመጫወቻ ካርዱ ላይ በቀይ ቀለም የተመረጡ ቁጥሮች የሚያሳዩት መጫወቻ ካርድ በሌላ ተጫዋች መመረጡን ነው።\n\n3. የመጫወቻ ካርድ ስንነካው Preview ያሳየናል።\n\n4. ምዝገባ ሲያልቅ ወደ ጨዋታ ያስገባናል።</blockquote>\n\n` +
    `<blockquote><b>🎮 ጨዋታ</b>\n\n1. ቁጥሮች ከ1 እስከ 75 መጥራት ይጀምራል።\n\n2. ካርዶ ላይ ካለ ክሊክ በማረግ ይምረጡ።</blockquote>\n\n` +
    `<blockquote><b>🏆 አሸናፊ</b>\n\n1. ቁጥሮቹ ሲጠሩ ከመጫወቻ ካርዳችን ላይ እየመረጥን ወደጎን ወይም ወደታች ወይም ወደሁለቱም አግዳሚ ወይም አራቱን ማእዘናት ከመረጥን ወዲያውኑ ከታች በኩል <b>bingo</b> የሚለውን በመንካት ማሸነፍ እንችላለን።\n\n2. ወደጎን ወይም ወደታች ወይም ወደሁለቱም አግዳሚ ወይም አራቱን ማእዘናት ሳይጠሩ <b>bingo</b> የሚለውን ክሊክ ካደረግን ከጨዋታው እንታገዳለን።\n\n3. ሁለት ወይም ከዚያ በላይ ተጫዋቾች እኩል ቢያሸንፉ ደራሹ ለቁጥራቸው ይካፈላል።</blockquote>`;
    return ctx.replyWithHTML(htmlText);
};
bot.action('instructions_trigger', (ctx) => { ctx.answerCbQuery(); sendBeautifiedRules(ctx); });
bot.action('dep', (ctx) => { ctx.answerCbQuery(); ctx.session = { state: 'WAIT_AMT' }; ctx.reply("ማስገባት የፈለጉትን የብር መጠን ከ 10 ብር ጀምሮ ያስገቡ።"); });
bot.action('withdraw_start', async (ctx) => {
    const u = await User.findOne({ telegramId: ctx.from.id.toString() });
    if (!u || u.balance < 50) return ctx.reply("ዝቅተኛ ማውጣት የሚቻለውየገንዘብ መጠን 50 ብር ነው ።");
    ctx.session = { state: 'WAIT_W_AMT' }; ctx.reply("💰 ማውጣት የሚፈልጉትን የገንዘብ መጠን ያስገቡ ?");
});
bot.action(/w_meth_(.+)/, (ctx) => {
    const meth = ctx.match[1]; ctx.session.method = meth; ctx.session.state = 'WAIT_W_ID';
    const prompt = (meth === 'CBE' || meth === 'Abyssinia') ? "እባክዎ የአካውንት ቁጥሮን ያስገቡ::" : "እባክዎ የስልክ ቁጥሮን ያስገቡ::";
    ctx.editMessageText(`🏦 ዘዴ: ${meth}\n👤 ${prompt}`);
});
bot.action('w_cancel', (ctx) => { ctx.session = null; ctx.editMessageText("❌ ተሰርዟል።"); });

// --- TEXT HANDLER ---
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const uid = ctx.from.id.toString();

    if (ctx.session?.state === 'WAIT_AMT') {
        const amt = parseInt(text); if (isNaN(amt) || amt < 10) return ctx.reply("ከ 10 ብር በላይ ያስገቡ።");
        ctx.session.amount = amt; ctx.session.state = null;
        return ctx.reply(`መጠን: ${amt} ብር\nእባክዎ የክፍያ ዘዴ ይምረጡ:`, Markup.inlineKeyboard([[Markup.button.callback("TELEBIRR", "pay_tele"), Markup.button.callback("COMMERCIAL BANK", "pay_cbe")],[Markup.button.callback("ABYSSINIA", "pay_aby"), Markup.button.callback("CBE BIRR", "pay_cbebirr")]]));
    }
    if (ctx.session?.state === 'WAIT_W_AMT') {
        const amt = parseInt(text); const u = await User.findOne({ telegramId: uid });
        if (isNaN(amt) || amt < 50) return ctx.reply("ዝቅተኛ ማውጣት የሚቻለውየገንዘብ መጠን 50 ብር ነው ።");
        if (amt > u.balance) return ctx.reply("ገንዘብ ለማውጣት በቂ Balance የለዎአትም። እባክዎ Deposit በማድረግ ይጫወቱ።");
        ctx.session.w_amt = amt; ctx.session.state = 'WAIT_W_METH';
        return ctx.reply("ዘዴ ይምረጡ:", withdrawMethods);
    }
    if (ctx.session?.state === 'WAIT_W_ID') { ctx.session.w_id = text; ctx.session.state = 'WAIT_W_NAME'; return ctx.reply("👤 እባክዎ የአካውንቱን ባለቤት ስም ያስገቡ::"); }
    if (ctx.session?.state === 'WAIT_W_NAME') {
        const { w_amt, method, w_id } = ctx.session;
        await User.findOneAndUpdate({ telegramId: uid }, { $inc: { balance: -w_amt } });
        ctx.reply(`✅ የገንዘብ ማውጣት ጥያቄዎ ለAdmin ተልኳል::\nመጠን: ${w_amt} ብር\nዘዴ: ${method}\nID: ${w_id}\nስም: ${text}`);
        if(ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `🚨 WITHDRAWAL REQUEST\nUser: ${uid}\nAmt: ${w_amt}\nMeth: ${method}\nID: ${w_id}\nName: ${text}`);
        ctx.session = null; return;
    }
    const sms = parseBankSMS(text);
    if (sms) {
        const record = await VerifiedSMS.findOne({ refNumber: sms.ref, isUsed: false });
        if (record) {
            record.isUsed = true; await record.save();
            const u = await User.findOneAndUpdate({ telegramId: uid }, { $inc: { balance: record.amount } }, { new: true });
            io.to(uid).emit('balance_update', u.balance); ctx.reply(`✅ ${record.amount} ብር ገብቷል።`);
        }
    }
});

// REGISTER & WELCOME BONUS LOGIC
bot.on('contact', async (ctx) => {
    const existingUser = await User.findOne({ telegramId: ctx.from.id.toString() });
    let bonusText = "";

    // If it's a new registration
    if (existingUser && !existingUser.isRegistered) {
        await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { 
            phoneNumber: ctx.message.contact.phone_number, 
            isRegistered: true,
            $inc: { balance: 10 } // 10 BIRR BONUS
        });
        bonusText = "\n🎁 ለእርሶ የ 10 ብር የጅማሮ ቦነስ በWalletዎ ላይ ተጨምሯል!";
    } else {
        await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { phoneNumber: ctx.message.contact.phone_number, isRegistered: true });
    }

    ctx.reply(`✅ ተመዝግበዋል! አሁን መጫወት ይችላሉ።${bonusText}`, Markup.removeKeyboard());
    ctx.reply("Main Menu:", mainKeyboard(true));
});

bot.action('pay_tele', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 0922573939 (SEID) ${ctx.session.amount || 10} ብር ይላኩ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('pay_cbe', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 1000102526418 (Acc) ${ctx.session.amount || 10} ብር ያስገቡ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('pay_aby', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 88472845 (Acc) ${ctx.session.amount || 10} ብር ያስገቡ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('pay_cbebirr', (ctx) => ctx.reply(`${supportHeader}\n\n1. ወደ 0922573939 (CBE BIRR) ${ctx.session.amount || 10} ብር ይላኩ\n\n2. የደረሰኙን መልዕክት Past ያድርጉ 👇`));
bot.action('bal', async (ctx) => { const u = await User.findOne({ telegramId: ctx.from.id.toString() }); ctx.reply(`💰 Balance: ${u?.balance || 0} Birr`); });

bot.launch();

// --- 7. SERVE FRONTEND ---
const publicPath = path.resolve(__dirname, 'public');
app.use(express.static(publicPath));
app.get('*', (req, res) => {
    if (req.path.includes('.') && !req.path.endsWith('.html')) return res.status(404).end();
    res.sendFile(path.join(publicPath, 'index.html'));
});
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Live on ${PORT}`));
