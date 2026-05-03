module.exports = {
    // Настройки Telegram
    telegram: {
        token: process.env.TELEGRAM_TOKEN || '',  // Токен бота из .env
        channel: process.env.TELEGRAM_CHANNEL || "@pumpscrin"              // Канал для публикации сигналов
        // Можно также использовать ID канала (начинается с -100):
        // channel: "-1001234567890"
    },
    
    ntfy: {
        topic: process.env.NTFY_TOPIC || ''
    },
    
    // Настройки Binance
    binance: {
        fapiBaseUrl: "https://fapi.binance.com"  // API для фьючерсов
    },
    
    // Параметры сканирования
    TIMEFRAME: "30m",          // Таймфрейм для свечей
    INTERVAL_MINUTES: 1,      // Интервал сканирования (минуты)
    
    // Пороги для сигналов (%)
    OI_THRESHOLD: 3,          // Изменение Open Interest
    PRICE_THRESHOLD: 1,       // Изменение цены
    VOLUME_THRESHOLD: 1,      // Изменение объёма
    
    // Производительность
    CONCURRENCY: 20,          // Количество параллельных запросов
    
    // Логирование
    LOG_LEVEL: "info"         // Уровень логирования (debug, info, warn, error)
};