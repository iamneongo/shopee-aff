// Tách một lệnh cURL (dạng "Copy as cURL (bash)" của Chrome) thành
// { url, method, headers, body }. Bỏ qua các header vô nghĩa khi replay.

const SKIP_HEADERS = new Set(["accept-encoding", "content-length", "host"]);

// Tokenizer hiểu quote kiểu shell: '...', "...", $'...' và nối dòng bằng '\'
function tokenize(input) {
  const s = input.replace(/\\\r?\n/g, " "); // gộp dòng nối bằng backslash
  const tokens = [];
  let i = 0;
  const n = s.length;

  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    const ch = s[i];

    if (ch === "'") {
      i++;
      let buf = "";
      while (i < n && s[i] !== "'") buf += s[i++];
      i++;
      tokens.push(buf);
    } else if (ch === '"') {
      i++;
      let buf = "";
      while (i < n && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < n) {
          buf += s[i + 1];
          i += 2;
        } else buf += s[i++];
      }
      i++;
      tokens.push(buf);
    } else if (ch === "$" && s[i + 1] === "'") {
      // ANSI-C quoting: $'...!...'
      i += 2;
      let buf = "";
      while (i < n && s[i] !== "'") {
        if (s[i] === "\\" && i + 1 < n) {
          const e = s[i + 1];
          if (e === "n") buf += "\n";
          else if (e === "t") buf += "\t";
          else if (e === "r") buf += "\r";
          else if (e === "u") {
            buf += String.fromCharCode(parseInt(s.substr(i + 2, 4), 16));
            i += 6;
            continue;
          } else buf += e;
          i += 2;
        } else buf += s[i++];
      }
      i++;
      tokens.push(buf);
    } else {
      let buf = "";
      while (i < n && !/\s/.test(s[i]) && s[i] !== "'" && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < n) {
          buf += s[i + 1];
          i += 2;
        } else buf += s[i++];
      }
      tokens.push(buf);
    }
  }
  return tokens;
}

function parseCurl(input) {
  const tokens = tokenize(input);
  const headers = {};
  let url = null;
  let method = null;
  let cookie = null;
  let body = null;

  const addHeader = (raw) => {
    const idx = raw.indexOf(":");
    if (idx < 0) return;
    const name = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (!name) return;
    if (name.toLowerCase() === "cookie") {
      cookie = value;
      return;
    }
    if (SKIP_HEADERS.has(name.toLowerCase())) return;
    headers[name] = value;
  };

  let i = tokens[0] === "curl" ? 1 : 0;
  for (; i < tokens.length; i++) {
    let t = tokens[i];
    let inlineVal = null;
    if (t.startsWith("--") && t.includes("=")) {
      const eq = t.indexOf("=");
      inlineVal = t.slice(eq + 1);
      t = t.slice(0, eq);
    }
    const next = () => (inlineVal !== null ? inlineVal : tokens[++i]);

    switch (t) {
      case "-H":
      case "--header":
        addHeader(next());
        break;
      case "-b":
      case "--cookie":
        cookie = next();
        break;
      case "-X":
      case "--request":
        method = next();
        break;
      case "--url":
        url = next();
        break;
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
        body = next();
        break;
      case "-e":
      case "--referer":
        addHeader("referer: " + next());
        break;
      case "-A":
      case "--user-agent":
        addHeader("user-agent: " + next());
        break;
      default:
        if (!t.startsWith("-") && /^https?:\/\//.test(t) && !url) url = t;
        // các cờ khác (-s, --compressed, ...) bỏ qua
        break;
    }
  }

  if (cookie) headers.Cookie = cookie;
  if (!method) method = body ? "POST" : "GET";

  return { url, method, headers, body };
}

module.exports = { parseCurl, tokenize };
