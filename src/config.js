const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

// Đọc config từ config.json (nếu có) rồi merge với env vars.
// Env vars luôn thắng để Dokploy/Docker có thể inject mà không cần file.
function loadConfig() {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    // config.json không bắt buộc khi dùng env vars
  }

  const env = process.env;
  const envOverrides = {};

  if (env.MODE)           envOverrides.mode   = env.MODE;
  if (env.SERVER_API_KEY) envOverrides.apiKey = env.SERVER_API_KEY;
  if (env.PORT)           envOverrides.port   = Number(env.PORT);

  if (env.ADDLIVETAG_API_KEY || env.ADDLIVETAG_AFFID) {
    envOverrides.addlivetag = {
      ...(fileConfig.addlivetag || {}),
      ...(env.ADDLIVETAG_API_KEY ? { apiKey: env.ADDLIVETAG_API_KEY } : {}),
      ...(env.ADDLIVETAG_AFFID   ? { affid:  env.ADDLIVETAG_AFFID   } : {}),
    };
  }

  if (env.SADCAPTCHA_API_KEY) {
    envOverrides.sadcaptcha = {
      ...(fileConfig.sadcaptcha || {}),
      apiKey: env.SADCAPTCHA_API_KEY,
    };
  }

  const cfg = { ...fileConfig, ...envOverrides };

  // Chỉ báo lỗi nếu cả file lẫn env đều trống hoàn toàn
  if (!cfg.mode && !cfg.puppeteer && !cfg.addlivetag) {
    throw new Error(
      `Chưa có config. Copy config.example.json → config.json và điền thông tin, ` +
      `hoặc đặt env vars MODE, ADDLIVETAG_API_KEY, ADDLIVETAG_AFFID.`
    );
  }

  return cfg;
}

module.exports = { loadConfig, CONFIG_PATH };
