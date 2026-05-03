require('dotenv').config();

 function getNumberEnv(name, fallback) {
   const rawValue = process.env[name];
   if (!rawValue) {
     return fallback;
   }

   const parsedValue = Number(rawValue);
   return Number.isFinite(parsedValue) ? parsedValue : fallback;
 }

module.exports = {
  telegram: {
    token: process.env.TELEGRAM_TOKEN || ''
  },

  ntfy: {
    topic: process.env.NTFY_TOPIC || ''
  },

  targets: {
    bot: process.env.TELEGRAM_CHAT_ID,
    channel: process.env.TELEGRAM_CHANNEL
  },

  bybit: {
    minSize: getNumberEnv('BYBIT_MIN_SIZE', 100000),
    aggregationInterval: getNumberEnv('AGGREGATION_INTERVAL', 60),
    longThreshold: getNumberEnv('LONG_THRESHOLD', 200000),
    shortThreshold: getNumberEnv('SHORT_THRESHOLD', 200000)
  }
};

