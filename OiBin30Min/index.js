require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const pLimit = require('p-limit');
const winston = require('winston');
const config = require('./config.js');

// ⬇️ СНАЧАЛА LOGGER
const logger = winston.createLogger({
    level: config.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, stack }) =>
            stack ? `${timestamp} [${level.toUpperCase()}]: ${message}\n${stack}` :
            `${timestamp} [${level.toUpperCase()}]: ${message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({
            filename: 'logs/screener.log',
            maxsize: 5242880,
            maxFiles: 5
        }),
        new winston.transports.File({
            filename: 'logs/errors.log',
            level: 'error',
            maxsize: 5242880,
            maxFiles: 5
        })
    ]
});

if (!config.telegram.token && !config.ntfy.topic) {
    logger.error('Не задан ни TELEGRAM_TOKEN, ни NTFY_TOPIC');
    process.exit(1);
}

// Инициализация бота с обработкой ошибок
const { HttpsProxyAgent } = require('https-proxy-agent');

let bot;
if (config.telegram.token) {
    try {
        bot = new TelegramBot(config.telegram.token, {
            polling: true,
            request: {
                timeout: 60000,
                agent: new HttpsProxyAgent('http://185.199.228.220:7300')
            }
        });
    } catch (error) {
        logger.error(`Ошибка инициализации бота: ${error.message}`);
    }
}

if (bot) {
    bot.on('polling_error', (error) => {
        logger.error(`Ошибка polling Telegram: ${error.message}`);
    });
}

const TARGET_CHANNEL = config.telegram.channel;
const NTFY_TOPIC = config.ntfy.topic;

// Проверка структуры канала (должно начинаться с @ или -100)
if (!TARGET_CHANNEL || (TARGET_CHANNEL[0] !== '@' && !TARGET_CHANNEL.startsWith('-100'))) {
    logger.error(`Некорректный формат канала: ${TARGET_CHANNEL}. Должен начинаться с @ или -100`);
}

// Приветственное сообщение при запуске
if (bot) {
    bot.onText(/\/start/, async (msg) => {
        try {
            await bot.sendMessage(msg.chat.id, "✅ Pump Screener запущен и работает!");
            logger.info(`Bot started by user ${msg.from.id}`);
        } catch (error) {
            logger.error(`Ошибка отправки /start: ${error.message}`);
        }
    });
}

// Команда статуса
if (bot) {
    bot.onText(/\/status/, async (msg) => {
        try {
            const stats = {
                cacheSize: sentSignalsCache.size,
                monitoredPairs: lastOI.size,
                lastScan: new Date(lastScanTime).toLocaleString('ru-RU')
            };
            
            await bot.sendMessage(
                msg.chat.id,
                `📊 Статус бота:\n` +
                `• Пар в мониторинге: ${stats.monitoredPairs}\n` +
                `• Сигналов в кэше: ${stats.cacheSize}\n` +
                `• Последнее сканирование: ${stats.lastScan}\n` +
                `• Следующее сканирование: через ${INTERVAL_MINUTES} мин`
            );
        } catch (error) {
            logger.error(`Ошибка отправки статуса: ${error.message}`);
        }
    });
}

// Конфигурация
const BASE_FAPI = config.binance.fapiBaseUrl;
const TIMEFRAME = config.TIMEFRAME;
const INTERVAL_MINUTES = config.INTERVAL_MINUTES;
const OI_THRESHOLD = config.OI_THRESHOLD;
const PRICE_THRESHOLD = config.PRICE_THRESHOLD;
const VOLUME_THRESHOLD = config.VOLUME_THRESHOLD;
const CONCURRENCY = config.CONCURRENCY || 5; // Защита от undefined

// Глобальная переменная для хранения времени последнего сканирования
let lastScanTime = Date.now();

// Кэши для хранения предыдущих значений
const lastOI = new Map(); // Используем Map вместо объекта для лучшей производительности
const sentSignalsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 минут

async function sendNtfy(title, message, priority = 'high', tags = 'rotating_light') {
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
        logger.info(`✅ ntfy уведомление отправлено: ${title}`);
        return true;
    } catch (error) {
        logger.error(`❌ Ошибка отправки ntfy: ${error.message}`);
        return false;
    }
}

// Функция для отправки тестового сообщения в канал
async function testChannelAccess() {
    if (!bot || !TARGET_CHANNEL) {
        logger.warn('Telegram недоступен или канал не задан, проверка канала пропущена');
        return false;
    }

    try {
        await bot.sendMessage(TARGET_CHANNEL, "🔧 Тестовое сообщение: бот запущен и готов к работе!", {
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
        logger.info("✅ Тестовое сообщение успешно отправлено в канал");
        return true;
    } catch (error) {
        logger.error(`❌ Ошибка отправки тестового сообщения: ${error.message}`);
        
        if (error.response?.statusCode === 403) {
            logger.error("⚠️  Бот не имеет прав на отправку сообщений в канал.");
            logger.error("   Решение: добавьте бота в канал как администратора с правом отправки сообщений");
        } else if (error.response?.statusCode === 400) {
            logger.error("⚠️  Неверный идентификатор канала.");
            logger.error("   Решение: убедитесь, что канал указан в формате @channelname или -1001234567890");
        }
        return false;
    }
}

// Получение списка фьючерсных пар с кэшированием
let symbolsCache = null;
let symbolsCacheTime = 0;
const SYMBOLS_CACHE_TTL = 10 * 60 * 1000; // 10 минут

async function getFuturesSymbols() {
    const now = Date.now();
    
    if (symbolsCache && (now - symbolsCacheTime) < SYMBOLS_CACHE_TTL) {
        return symbolsCache;
    }
    
    try {
        const resp = await axios.get(`${BASE_FAPI}/fapi/v1/exchangeInfo`, {
            timeout: 10000
        });
        const symbols = resp.data.symbols
            .filter(s => s.contractType === "PERPETUAL" && s.status === "TRADING")
            .map(s => s.symbol);
        
        symbolsCache = symbols;
        symbolsCacheTime = now;
        
        logger.info(`Загружено ${symbols.length} фьючерсных пар`);
        return symbols;
    } catch (error) {
        logger.error(`Ошибка при получении списка пар: ${error.message}`);
        
        // Возвращаем кэш, если есть
        if (symbolsCache) {
            logger.warn("Используем кэшированный список пар");
            return symbolsCache;
        }
        
        return [];
    }
}

// Получение Open Interest с ретраями
async function getOpenInterest(symbol, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const resp = await axios.get(`${BASE_FAPI}/fapi/v1/openInterest`, { 
                params: { symbol },
                timeout: 5000 
            });
            return Number(resp.data.openInterest);
        } catch (error) {
            if (attempt === retries) {
                logger.warn(`Не удалось получить OI для ${symbol}: ${error.message}`);
                return null;
            }
            // Ждем перед повторной попыткой
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
    }
}

// Получение свечей с ретраями
async function getKlines(symbol, limit = 3, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const resp = await axios.get(`${BASE_FAPI}/fapi/v1/klines`, {
                params: { 
                    symbol, 
                    interval: TIMEFRAME, 
                    limit 
                },
                timeout: 5000
            });

            return resp.data.map(k => ({
                start: Number(k[0]),
                open: Number(k[1]),
                high: Number(k[2]),
                low: Number(k[3]),
                close: Number(k[4]),
                volume: Number(k[5]),
                quoteVolume: Number(k[7])
            }));
        } catch (error) {
            if (attempt === retries) {
                logger.warn(`Не удалось получить свечи для ${symbol}: ${error.message}`);
                return [];
            }
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
    }
}

// Расчёт процентного изменения
function pctChange(newV, oldV) {
    if (!oldV || Math.abs(oldV) < 1) return 0;
    return ((newV - oldV) / Math.abs(oldV)) * 100;
}

// Проверка, был ли недавно отправлен сигнал по этой паре
function isDuplicateSignal(symbol, direction) {
    const key = `${symbol}_${direction}`;
    const now = Date.now();
    const lastSent = sentSignalsCache.get(key);
    
    if (lastSent && (now - lastSent) < CACHE_TTL) {
        return true;
    }
    
    sentSignalsCache.set(key, now);
    
    // Очистка старых записей (раз в 100 проверок для производительности)
    if (Math.random() < 0.01) {
        for (const [cacheKey, timestamp] of sentSignalsCache.entries()) {
            if (now - timestamp > CACHE_TTL) {
                sentSignalsCache.delete(cacheKey);
            }
        }
    }
    
    return false;
}

// Отправка сигнала в Telegram-канал
async function sendSignal(symbol, oiPct, pricePct, volPct, currentPrice, direction) {
    try {
        // Определяем направление и эмодзи
        let directionEmoji = "";
        let trendText = "";
        
        if (direction === "up") {
            directionEmoji = "🚀";
            trendText = "БЫЧЬИ";
        } else {
            directionEmoji = "⚠️";
            trendText = "МЕДВЕЖЬИ";
        }
        
        // Форматируем сообщение
        const message = `
${directionEmoji} <b> OI screener </b> ${directionEmoji}

<b>ПАРА:</b> ${symbol}
<b>ТЕНДЕНЦИЯ:</b> <u>${trendText}</u>

<b>📊 Open Interest:</b> ${oiPct > 0 ? "↗️" : "↘️"} <b>${oiPct.toFixed(2)}%</b>
<b>💵 Цена:</b> ${pricePct > 0 ? "🟢" : "🔴"} <b>${pricePct.toFixed(2)}%</b>
<b>📈 Объём:</b> ${volPct > 0 ? "📈" : "📉"} <b>${volPct.toFixed(2)}%</b>

<b>Текущая цена:</b> $${currentPrice.toFixed(4)}

<i>Сканер: Binance OI Screener | Таймфрейм: ${TIMEFRAME}</i>
        `.trim();

        const ntfySent = await sendNtfy(`OiBin30Min ${symbol}`, message, 'high', direction === 'up' ? 'chart_with_upwards_trend' : 'warning');
        let telegramSent = false;

        if (bot && TARGET_CHANNEL) {
            await bot.sendMessage(TARGET_CHANNEL, message, { 
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
            telegramSent = true;
        }

        if (!ntfySent && !telegramSent) {
            throw new Error('Не удалось отправить уведомление ни в ntfy, ни в Telegram');
        }
        
        logger.info(`📤 Сигнал отправлен в канал: ${symbol} (${direction})`);
        return true;
    } catch (error) {
        logger.error(`❌ Ошибка при отправке сигнала: ${error.message}`);
        
        if (error.response?.statusCode === 403) {
            logger.error("⚠️ Бот не имеет прав на публикацию в канале");
            logger.error("   Добавьте бота в канал как администратора с правом отправки сообщений");
        }
        
        return false;
    }
}

// Основная функция сканирования
async function runOnce() {
    const scanStartTime = Date.now();
    lastScanTime = scanStartTime;
    logger.info(`🔍 Начало сканирования...`);

    const symbols = await getFuturesSymbols();
    if (symbols.length === 0) {
        logger.warn("Список пар пуст, пропускаем сканирование");
        return;
    }

    const limit = pLimit(CONCURRENCY);
    let signalsFound = 0;
    let errors = 0;

    // Случайное перемешивание пар для равномерной нагрузки
    const shuffledSymbols = [...symbols].sort(() => Math.random() - 0.5);

    await Promise.all(shuffledSymbols.map(symbol =>
        limit(async () => {
            try {
                const oiNow = await getOpenInterest(symbol);
                if (oiNow === null) {
                    errors++;
                    return;
                }

                const klines = await getKlines(symbol, 3);
                if (klines.length < 3) {
                    errors++;
                    return;
                }

                const prev = klines[1];
                const last = klines[2];

                // Рассчитываем изменения
                const prevOI = lastOI.get(symbol);
                let oiPct = 0;
                if (prevOI != null) {
                    oiPct = pctChange(oiNow, prevOI);
                }
                lastOI.set(symbol, oiNow);

                const pricePct = pctChange(last.close, prev.close);
                const volPct = pctChange(last.volume, prev.volume);

                // Абсолютные значения для проверки порогов
                const absOi = Math.abs(oiPct);
                const absPrice = Math.abs(pricePct);
                const absVol = Math.abs(volPct);

                // Проверка условий для сигнала
                const isSignal = 
                    absOi >= OI_THRESHOLD &&
                    absPrice >= PRICE_THRESHOLD &&
                    absVol >= VOLUME_THRESHOLD;

                if (isSignal) {
                    const direction = pricePct > 0 ? "up" : "down";
                    
                    // Проверяем, не отправляли ли мы недавно такой же сигнал
                    if (!isDuplicateSignal(symbol, direction)) {
                        const sent = await sendSignal(
                            symbol, 
                            oiPct, 
                            pricePct, 
                            volPct, 
                            last.close, 
                            direction
                        );
                        
                        if (sent) {
                            signalsFound++;
                        }
                    } else {
                        logger.debug(`Пропущен дублирующий сигнал: ${symbol}`);
                    }
                }

            } catch (error) {
                errors++;
                logger.warn(`Ошибка при обработке ${symbol}: ${error.message}`);
            }
        })
    ));

    const scanDuration = Date.now() - scanStartTime;
    logger.info(`✅ Сканирование завершено за ${scanDuration}ms. Найдено сигналов: ${signalsFound}, Ошибок: ${errors}`);
}

// Запуск и циклическое выполнение
async function main() {
    try {
        logger.info("🤖 Binance OI Screener запускается...");
        logger.info(`📢 Канал назначения: ${TARGET_CHANNEL}`);
        logger.info(`⚙️  Пороги: OI=${OI_THRESHOLD}%, Цена=${PRICE_THRESHOLD}%, Объём=${VOLUME_THRESHOLD}%`);
        logger.info(`⏱️  Интервал сканирования: ${INTERVAL_MINUTES} минут`);
        logger.info(`🎯 Конкурентность: ${CONCURRENCY} запросов`);
        if (NTFY_TOPIC) {
            logger.info(`📲 ntfy topic: ${NTFY_TOPIC}`);
        }
        
        await sendNtfy('OiBin30Min', `Бот запущен. Таймфрейм: ${TIMEFRAME}. Интервал: ${INTERVAL_MINUTES} мин.`, 'high', 'satellite');
        
        // Проверка доступа к каналу
        const channelAccess = await testChannelAccess();
        if (bot && !channelAccess) {
            logger.warn("⚠️  Проблемы с доступом к каналу. Бот продолжит работу, но сигналы могут не отправляться.");
        }
        
        // Первый запуск
        await runOnce();
        
        // Установка интервала
        setInterval(async () => {
            try {
                await runOnce();
            } catch (error) {
                logger.error(`Ошибка в scheduled сканировании: ${error.message}`);
            }
        }, INTERVAL_MINUTES * 60 * 1000);
        
        logger.info("✅ Бот успешно запущен и работает в фоновом режиме");
        
    } catch (error) {
        logger.error(`Критическая ошибка: ${error.message}`);
        process.exit(1);
    }
}

// Обработка завершения работы
process.on('SIGINT', () => {
    logger.info('🛑 Остановка бота...');
    if (bot?.isPolling()) {
        bot.stopPolling();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('🛑 Получен сигнал завершения...');
    if (bot?.isPolling()) {
        bot.stopPolling();
    }
    process.exit(0);
});

process.on('unhandledRejection', (error) => {
    logger.error(`Необработанное исключение: ${error.message}`, error);
});

process.on('uncaughtException', (error) => {
    logger.error(`Неперехваченное исключение: ${error.message}`, error);
    process.exit(1);
});

// Запуск
main();