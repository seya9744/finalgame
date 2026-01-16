require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

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
    telegramId: String, username: String, gameId: String, status: String, stake: Number, prize: Number, date: { type: Date, default: Date.now }
}));

const VerifiedSMS = mongoose.model('VerifiedSMS', new mongoose.Schema({
    refNumber: { type: String, unique: true }, amount: Number, fullText: String, isUsed: { type: Boolean, default: false }, usedBy: { type: String, default: null }, createdAt: { type: Date, default: Date.now, expires: 172800 } 
}));

// --- ENGINE ---
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
    const corners = [card[0][0], card[0][4], card[4][0], card[4][4]];
    if (corners.every(n => drawn.has(n))) return true;
    return false;
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
        let total = 0;
        Object.values(players).forEach(p => { if (p.cards) total += p.cards.length; });
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
}, 3500);

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('register_user', async (data) => {
        try {
            const urlParams = new URLSearchParams(data.initData); 
            const user = JSON.parse(urlParams.get('user')); 
            const tid = user.id.toString();
            socket.join(tid); socketToUser[socket.id] = tid;
            const u = await User.findOne({ telegramId: tid });
            if (u && u.isRegistered) {
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
            
            // 1. Set the game state to Winner immediately
            gameState.phase = 'WINNER';
            gameState.winner = { username: players[tid].username, prize, cardId: data.cardId };
            gameState.phaseEndTime = Date.now() + 7000;

            // 2. Loop through EVERYONE who was in the game
            for (let pTid in players) {
                const isWinner = (pTid === tid);
                const pCards = players[pTid].cards || [];

                // Only process players who actually bought cards
                if (pCards.length > 0) {
                    
                    // Update the User Profile (Balance and Total Played count)
                    await User.findOneAndUpdate(
                        { telegramId: pTid }, 
                        { 
                            $inc: { 
                                balance: isWinner ? prize : 0, 
                                gamesWon: isWinner ? 1 : 0,
                                totalPlayed: 1 // Everyone gets +1 game played
                            } 
                        }
                    );

                    // Create the History Record for the Leaderboard
                    await GameRecord.create({
                        telegramId: pTid,
                        username: players[pTid].username,
                        gameId: "BBU7EN",
                        status: isWinner ? "Won" : "Lost",
                        stake: pCards.length * 10,
                        prize: isWinner ? prize : 0,
                        date: new Date()
                    });
                }
            }

            // 3. Update the winner's screen with their new balance
            const winUser = await User.findOne({ telegramId: tid });
            if (winUser) io.to(tid).emit('balance_update', winUser.balance);

            // 4. Tell everyone the game is over
            io.emit('game_tick', gameState);
        }
    }
});

   socket.on('get_leaderboard', async (period) => {
    try {
        let players;

        if (period === 'All-Time') {
            // 1. Get EVERY user from the User Profile collection
            players = await User.find({ totalPlayed: { $gt: 0 } })
                .sort({ totalPlayed: -1 })
                .limit(20)
                .select('username totalPlayed -_id');
        } else {
            // 2. For Daily/Weekly, use the GameRecord history
            let startTime = new Date();
            if (period === 'Daily') startTime.setHours(0, 0, 0, 0);
            else if (period === 'Weekly') startTime.setDate(startTime.getDate() - 7);

            players = await GameRecord.aggregate([
                { $match: { date: { $gte: startTime } } },
                { $group: { _id: "$telegramId", count: { $sum: 1 } } },
                { $lookup: { from: "users", localField: "_id", foreignField: "telegramId", as: "u" } },
                { $unwind: "$u" },
                { $project: { _id: 0, username: "$u.username", totalPlayed: "$count" } },
                { $sort: { totalPlayed: -1 } }
            ]);
        }

        // Send the data to the frontend
        socket.emit('leaderboard_data', players);
    } catch (err) {
        console.error("Leaderboard Error:", err);
        socket.emit('leaderboard_data', []);
    }
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

    socket.on('disconnect', () => { delete socketToUser[socket.id]; });
});

// --- BOT MENU ---
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

bot.telegram.setMyCommands([
    { command: 'start', description: 'Start' }, { command: 'register', description: 'Register' }, { command: 'play', description: 'Play' },
    { command: 'deposit', description: 'Deposit' }, { command: 'balance', description: 'Balance' }, { command: 'withdraw', description: 'Withdraw' },
    { command: 'transfer', description: 'Transfer' }, { command: 'instruction', description: 'Instruction' }, { command: 'support', description: 'Support' }
]);
bot.telegram.setChatMenuButton({ menuButton: { type: 'default' } });

const mainKeyboard = (isReg) => {
    const rows = [];
    if (isReg) rows.push([Markup.button.webApp("Play 🎮", MINI_APP_URL), Markup.button.callback("Register 📝", "reg_prompt")]);
    else rows.push([Markup.button.callback("Register 📝", "reg_prompt")]);
    rows.push([Markup.button.callback("Balance 💵", "bal"), Markup.button.callback("Deposit 💰", "dep")]);
    rows.push([Markup.button.callback("Contact Support...", "support_trigger"), Markup.button.callback("Instruction 📖", "instructions_trigger")]);
    rows.push([Markup.button.callback("Transfer 🎁", "transfer"), Markup.button.callback("Withdraw 🤑", "w_start")]);
    rows.push([Markup.button.callback("Invite 🔗", "invite")]);
    return Markup.inlineKeyboard(rows);
};

const contactKey = Markup.keyboard([[Markup.button.contactRequest("📞 Share contact")]]).resize().oneTime();
const supportHeader = `የሚያጋጥማቹ የክፍያ ችግር: \n @sya9744\n@Komodo27 ላይ ፃፉልን።`;

bot.start(async (ctx) => {
    const user = await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { username: ctx.from.first_name }, { upsert: true, new: true });
    if (!user.isRegistered) await ctx.reply("Share phone to earn 10 Birr Bonus.", contactKey);
    await ctx.reply(`👋 Welcome to Dil Bingo! Choose an Option below.`, mainKeyboard(user.isRegistered));
});

bot.on('contact', async (ctx) => {
    const ex = await User.findOne({ telegramId: ctx.from.id.toString() });
    let bonus = "";
    if (ex && !ex.isRegistered) {
        await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { phoneNumber: ctx.message.contact.phone_number, isRegistered: true, $inc: { balance: 10 } });
        bonus = "\n🎁 ለእርሶ የ 10 ብር ቦነስ ተጨምሯል!";
    } else {
        await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { phoneNumber: ctx.message.contact.phone_number, isRegistered: true });
    }
    ctx.reply(`✅ ተመዝግበዋል!${bonus}`, Markup.removeKeyboard());
    ctx.reply("Main Menu:", mainKeyboard(true));
});

bot.action('instructions_trigger', (ctx) => {
    ctx.answerCbQuery();
    ctx.replyWithHTML(`<b>📘 የቢንጎ ጨዋታ ህጎች</b>\n\n` +
    `<blockquote><b>🃏 መጫወቻ ካርድ</b>\n\n1. ከ1-300 ካርድ አንዱን እንመርጣለን።\n2. ቀይ ቀለም የተመረጡት በሌልች ተጫዋቾች ነው።\n3. የመጫወቻ ካርድ ሲነካ Preview ያሳያል።\n4. ጊዜ ሲያልቅ ጨዋታው ይጀምራል።</blockquote>\n\n` +
    `<blockquote><b>🎮 ጨዋታ</b>\n\n1. ቁጥሮች ከ1 እስከ 75 ይጠራሉ።\n2. ካርዶ ላይ ካለ ቁጥሩን ይንኩት።\n3. የተሳሳቱ ከጨዋታ ይታገዳሉ።</blockquote>\n\n` +
    `<blockquote><b>🏆 አሸናፊ</b>\n\n1. መስመር ሲሞሉ Bingo በመንካት ያሸንፉ።</blockquote>`);
});

bot.action('dep', (ctx) => { ctx.session = { state: 'WAIT_AMT' }; ctx.reply("ማስገባት የፈለጉትን የብር መጠን ከ 10 ብር ጀምሮ ያስገቡ።"); });
bot.action('w_start', async (ctx) => {
    const u = await User.findOne({ telegramId: ctx.from.id.toString() });
    if (!u || u.balance < 50) return ctx.reply("ዝቅተኛ ማውጫ 50 ብር ነው::");
    ctx.session = { state: 'WAIT_W' }; ctx.reply("💰 ማውጣት የሚፈልጉትን መጠን ያስገቡ?");
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text; const uid = ctx.from.id.toString();
    if (ctx.session?.state === 'WAIT_AMT') {
        const amt = parseInt(text); if (isNaN(amt) || amt < 10) return ctx.reply("ከ 10 ብር በላይ ያስገቡ።");
        ctx.session.amount = amt; ctx.session.state = null;
        return ctx.reply(`መጠን: ${amt} ብር. ይምረጡ:`, Markup.inlineKeyboard([[Markup.button.callback("TELEBIRR", "pay_tele"), Markup.button.callback("CBE", "pay_cbe")]]));
    }
    if (ctx.session?.state === 'WAIT_W') {
        const amt = parseInt(text); const u = await User.findOne({ telegramId: uid });
        if (isNaN(amt) || amt < 50) return ctx.reply("ዝቅተኛ 50 ብር ነው ።");
        if (amt > u.balance) return ctx.reply("በቂ Balance የለዎትም።");
        ctx.reply(`✅ ለAdmin ተልኳል።`);
        if(ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `🚨 WITHDRAWAL REQUEST\nUser: ${uid}\nAmount: ${amt} Birr`);
        ctx.session = null; return;
    }
});

bot.action('support_trigger', (ctx) => ctx.reply(`🛠 Support: @sya9744 / @komodo27`));
bot.action('pay_tele', (ctx) => ctx.reply(`${supportHeader}\n\nወደ 0922573939 (SEID) ${ctx.session.amount || 10} ይላኩና መልዕክቱን Paste ያርጉ 👇`));
bot.action('pay_cbe', (ctx) => ctx.reply(`${supportHeader}\n\nወደ 1000102526418 (Acc) ${ctx.session.amount || 10} ያስገቡና መልዕክቱን Paste ያርጉ 👇`));

bot.launch();
const publicPath = path.resolve(__dirname, 'public');
app.use(express.static(publicPath));
app.get('*', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 live on ${PORT}`));








