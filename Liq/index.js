require('dotenv').config();
const axios = require('axios');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const winston = require('winston');
const config = require('./config.js');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

if (!config.telegram.token && !config.ntfy.topic) {
  logger.error('Не задан ни TELEGRAM_TOKEN, ни NTFY_TOPIC');
  process.exit(1);
}

const bot = config.telegram.token ? new TelegramBot(config.telegram.token, { polling: false }) : null;
const NTFY_TOPIC = config.ntfy.topic;
const TARGETS = [config.targets.channel, config.targets.bot].filter(Boolean);

if (TARGETS.length === 0 && !NTFY_TOPIC) {
  logger.error('Не задан ни один канал уведомлений. Укажите NTFY_TOPIC, TELEGRAM_CHAT_ID или TELEGRAM_CHANNEL');
  process.exit(1);
}

const excludedSymbols = ["BANANAS31USDT", "PUMPFUNUSDT"];
let sentSignals = new Set();
let aggregated = {};
let activeSocket = null;

async function sendNtfy(title, message, priority = 'high', tags = 'warning') {
  if (!NTFY_TOPIC) {
    return false;
  }

  try {
    await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, message, {
      headers: {
        Title: title,
        Priority: priority,
        Tags: tags
      },
      timeout: 10000
    });
    logger.info(`ntfy уведомление отправлено: ${title}`);
    return true;
  } catch (err) {
    logger.error(`Ошибка отправки ntfy: ${err.message}`);
    return false;
  }
}

async function getAllSymbols() {
  try {
    const url = 'https://api.bybit.com/v5/market/instruments-info?category=linear';
    const resp = await axios.get(url);
    if (!resp.data?.result?.list) return ['BTCUSDT'];

    return resp.data.result.list
      .map(i => i.symbol)
      .filter(sym => !excludedSymbols.includes(sym));
  } catch (err) {
    logger.error("Ошибка получения символов: " + err.message);
    return ['BTCUSDT'];
  }
}

async function sendSignal(msg) {
  let delivered = false;

  if (await sendNtfy('Liq', msg, 'high', 'money_with_wings')) {
    delivered = true;
  }

  if (bot) {
    for (const target of TARGETS) {
      try {
        const result = await bot.sendMessage(target, msg, {
          parse_mode: "HTML",
          disable_web_page_preview: true
        });
        logger.info(`Сообщение отправлено в ${target}, message_id=${result.message_id}`);
        delivered = true;
      } catch (err) {
        const details = err.response?.body ? JSON.stringify(err.response.body) : err.message;
        logger.error(`Ошибка отправки Telegram в ${target}: ${details}`);
      }
    }
  }

  if (!delivered) {
    throw new Error('Не удалось отправить уведомление ни в ntfy, ни в Telegram');
  }
}

async function connect() {
  const symbols = await getAllSymbols();
  const ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
  activeSocket = ws;

  ws.on('open', () => {
    logger.info('✅ WebSocket подключен к Bybit');
    logger.info(`Telegram targets: ${JSON.stringify(TARGETS)}`);
    const args = symbols.map(s => `allLiquidation.${s}`);
    ws.send(JSON.stringify({ op: "subscribe", args }));
    logger.info(`Подписка оформлена. Кол-во символов: ${args.length}`);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.topic && msg.data) {
        for (const item of msg.data) {
          const symbol = item.s;
          if (excludedSymbols.includes(symbol)) continue;

          const side = item.S;
          const size = Number(item.v);
          if (size < config.bybit.minSize) continue;

          if (!aggregated[symbol]) aggregated[symbol] = { long: 0, short: 0 };

          if (side === "Buy") aggregated[symbol].long += size;
          else aggregated[symbol].short += size;
        }
      }
    } catch (err) {
      logger.error("Ошибка разбора WS: " + err.message);
    }
  });

  ws.on('close', () => {
    if (activeSocket === ws) {
      activeSocket = null;
    }
    logger.warn('⚠ WebSocket закрыт. Переподключаемся через 5 сек...');
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    logger.error('❌ WS ошибка: ' + err.message);
    ws.close();
  });
}

setInterval(() => {
  for (const symbol in aggregated) {
    const long = aggregated[symbol].long;
    const short = aggregated[symbol].short;

    const longKey = `${symbol}-LONG-${long}`;
    const shortKey = `${symbol}-SHORT-${short}`;

    if (long >= config.bybit.longThreshold && !sentSignals.has(longKey)) {
      sentSignals.add(longKey);
      const msg = `🔥 <b>LONG Liquidation Spike</b>\n${symbol}\n💰 Amount: <b>${long.toLocaleString()} USD</b>`;
      sendSignal(msg);
      logger.info(`LONG spike: ${symbol} ${long}`);
    }

    if (short >= config.bybit.shortThreshold && !sentSignals.has(shortKey)) {
      sentSignals.add(shortKey);
      const msg = `❄️ <b>SHORT Liquidation Spike</b>\n${symbol}\n💰 Amount: <b>${short.toLocaleString()} USD</b>`;
      sendSignal(msg);
      logger.info(`SHORT spike: ${symbol} ${short}`);
    }

    aggregated[symbol].long = 0;
    aggregated[symbol].short = 0;
  }
}, config.bybit.aggregationInterval * 1000);

setInterval(() => {
  sentSignals.clear();
  logger.info("🗑 Кеш сигналов очищен");
}, 10 * 60 * 1000);

async function main() {
  try {
    if (NTFY_TOPIC) {
      logger.info(`ntfy topic: ${NTFY_TOPIC}`);
    }
    await sendSignal("📡 Liquidation Bot запущен (все символы, исключения активны)");
    await connect();
  } catch (err) {
    logger.error('Ошибка запуска: ' + err.message);
    process.exit(1);
  }
}

function shutdown() {
  logger.info('🛑 Остановка liquidation bot...');
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.close();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
