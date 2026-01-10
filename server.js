require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

// --- CONFIG ---
const { BOT_TOKEN, MONGODB_URI, PORT = 10000, MINI_APP_URL, ADMIN_ID } = process.env;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 1. DATABASE ---
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

// --- 2. BINGO LOGIC (KEEP ALL PREVIOUS LOGIC) ---
function parseBankSMS(text) {
    if (!text) return null;
    const refMatch = text.match(/[A-Z0-9]{10,12}/);
    const amountMatch = text.match(/(?:Birr|ETB|amt|amount)[:\s]*?([0-9.]+)/i) || text.match(/([0-9.]+)\s*?Birr/i);
    return (refMatch && amountMatch) ? { ref: refMatch[0], amount: parseFloat(amountMatch[1]) } : null;
}

// ... (Keep generateServerCard and checkServerWin functions)

// --- 3. GAME STATE & SOCKETS (KEEP ALL PREVIOUS LOGIC) ---
// ... (Keep gameState, setInterval loops, and io.on('connection'))

// --- 4. BOT MENU & ACTIONS ---
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

const mainKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.webApp("Play 🎮", MINI_APP_URL), Markup.button.callback("Register 📝", "reg_prompt")],
    [Markup.button.callback("Check Balance 💵", "bal"), Markup.button.callback("Deposit 💰", "dep")],
    [Markup.button.callback("Contact Support...", "support_trigger"), Markup.button.callback("Instruction 📖", "instructions_trigger")],
    [Markup.button.callback("Transfer 🎁", "transfer"), Markup.button.callback("Withdraw 🤑", "w_start")],
    [Markup.button.callback("Invite 🔗", "invite")]
]);

const contactKey = Markup.keyboard([[Markup.button.contactRequest("📞 Share contact")]]).resize().oneTime();

bot.start(async (ctx) => {
    const user = await User.findOneAndUpdate({ telegramId: ctx.from.id.toString() }, { username: ctx.from.first_name }, { upsert: true, new: true });
    if (!user.isRegistered) await ctx.reply("Welcome!", contactKey);
    await ctx.reply(`👋 Welcome to Dil Bingo! Choose an Option below.`, mainKeyboard());
});

// --- DEPOSIT FLOW ---
bot.action('dep', (ctx) => {
    ctx.answerCbQuery();
    ctx.session = { state: 'WAIT_DEP_AMT' };
    ctx.reply("ማስገባት የፈለጉትን የብር መጠን ከ 10 ብር ጀምሮ ያስገቡ።");
});

// --- WITHDRAW FLOW ---
bot.action('w_start', async (ctx) => {
    ctx.answerCbQuery();
    const u = await User.findOne({ telegramId: ctx.from.id.toString() });
    if (!u || u.balance < 10) return ctx.reply("❌ ዝቅተኛ የማውጫ መጠን 10 ብር ነው።");
    
    ctx.session = { state: 'WAIT_W_AMT' };
    ctx.reply("💰 ማውጣት የሚፈልጉትን የገንዘብ መጠን ያስገቡ ?");
});

const withdrawMethods = Markup.inlineKeyboard([
    [Markup.button.callback("Telebirr", "w_meth_Telebirr")],
    [Markup.button.callback("Commercial Bank", "w_meth_CBE")],
    [Markup.button.callback("Abyssinia Bank", "w_meth_Abyssinia")],
    [Markup.button.callback("CBE Birr", "w_meth_CBEBirr")],
    [Markup.button.callback("❌ Cancel", "w_cancel")]
]);

bot.action(/w_meth_(.+)/, (ctx) => {
    const method = ctx.match[1];
    ctx.session.method = method;
    ctx.session.state = 'WAIT_W_ID';
    const prompt = (method === 'CBE' || method === 'Abyssinia') ? "እባክዎ የአካውንት ቁጥሮን ያስገቡ::" : "እባክዎ የስልክ ቁጥሮን ያስገቡ::";
    ctx.editMessageText(`🏦 የመረጡት ዘዴ: ${method}\n👤 ${prompt}`);
});

bot.action('w_cancel', (ctx) => {
    ctx.session = null;
    ctx.editMessageText("❌ የገንዘብ ማውጣት ትዕዛዙ ተሰርዟል።");
});

// --- TEXT HANDLER FOR BOTH FLOWS ---
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const uid = ctx.from.id.toString();

    // 1. DEPOSIT: Waiting for Amount
    if (ctx.session?.state === 'WAIT_DEP_AMT') {
        const amt = parseInt(text);
        if (isNaN(amt) || amt < 10) return ctx.reply("እባክዎን ከ 10 ብር በላይ ያስገቡ።");
        ctx.session.amount = amt;
        ctx.session.state = null;
        return ctx.reply(`የመረጡት መጠን: ${amt} ብር\nእባክዎ የክፍያ ዘዴ ይምረጡ:`, Markup.inlineKeyboard([
            [Markup.button.callback("TELEBIRR", "pay_tele"), Markup.button.callback("COMMERCIAL BANK", "pay_cbe")],
            [Markup.button.callback("ABYSSINIA", "pay_aby"), Markup.button.callback("CBE BIRR", "pay_cbebirr")]
        ]));
    }

    // 2. WITHDRAW: Waiting for Amount
    if (ctx.session?.state === 'WAIT_W_AMT') {
        const amt = parseInt(text);
        const u = await User.findOne({ telegramId: uid });
        if (isNaN(amt) || amt < 10 || amt > u.balance) return ctx.reply("❌ የተሳሳተ መጠን ያስገቡ። እባክዎ በቂ ገንዘብ እንዳለዎት እና ከ 10 በላይ መሆኑን ያረጋግጡ።");
        ctx.session.w_amt = amt;
        ctx.session.state = 'WAIT_W_METH';
        return ctx.reply("💸 የሚፈልጉትን የክፍያ አማራጭ ይምረጡ:", withdrawMethods);
    }

    // 3. WITHDRAW: Waiting for Phone/Account Number
    if (ctx.session?.state === 'WAIT_W_ID') {
        ctx.session.w_id = text;
        ctx.session.state = 'WAIT_W_NAME';
        return ctx.reply("👤 እባክዎ የአካውንቱን ባለቤት ስም ያስገቡ::");
    }

    // 4. WITHDRAW: Final Step (Name)
    if (ctx.session?.state === 'WAIT_W_NAME') {
        const name = text;
        const { w_amt, method, w_id } = ctx.session;
        
        // Deduct from DB
        const u = await User.findOneAndUpdate({ telegramId: uid }, { $inc: { balance: -w_amt } }, { new: true });
        io.to(uid).emit('balance_update', u.balance);

        // Notify User
        ctx.reply(`✅ የገንዘብ ማውጣት ጥያቄዎ ለAdmin ተልኳል።\nመጠን: ${w_amt} ብር\nዘዴ: ${method}\nአካውንት: ${w_id}\nስም: ${name}`);

        // Notify Admin (Make sure ADMIN_ID is set in .env)
        if(ADMIN_ID) {
            bot.telegram.sendMessage(ADMIN_ID, `🚨 **NEW WITHDRAWAL REQUEST**\n\nUser: ${ctx.from.first_name} (@${ctx.from.username || 'N/A'})\nAmount: ${w_amt} Birr\nMethod: ${method}\nID: ${w_id}\nName: ${name}\n\nApprove via Admin Panel.`);
        }

        ctx.session = null; // Reset
        return;
    }

    // 5. DEPOSIT Reference Checker
    const smsData = parseBankSMS(text);
    if (smsData) {
        const record = await VerifiedSMS.findOne({ refNumber: smsData.ref, isUsed: false });
        if (record) {
            record.isUsed = true; await record.save();
            const u = await User.findOneAndUpdate({ telegramId: uid }, { $inc: { balance: record.amount } }, { new: true });
            io.to(uid).emit('balance_update', u.balance);
            ctx.reply(`✅ ተረጋግጧል! ${record.amount} ብር ገብቷል።`);
        }
    }
});

// --- (Keep Instructions, Support, and Other Button Actions) ---

bot.launch();

// --- SERVE FRONTEND ---
const publicPath = path.resolve(__dirname, 'public');
app.use(express.static(publicPath));
app.get('*', (req, res) => {
    if (req.path.includes('.') && !req.path.endsWith('.html')) return res.status(404).end();
    res.sendFile(path.join(publicPath, 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Live on ${PORT}`));
