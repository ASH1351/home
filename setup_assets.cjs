const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          const u = new URL(url);
          redirectUrl = u.origin + redirectUrl;
        }
        return fetchUrl(redirectUrl).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error('Status ' + res.statusCode + ' for ' + url));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function run() {
  const data = JSON.parse(fs.readFileSync('kage-source.json', 'utf8'));

  console.log('--- Processing Files ---');
  for (const file of data.files) {
    const fullPath = path.resolve(file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    let buf;
    if (file.code !== undefined) {
      buf = Buffer.from(file.code, 'utf8');
    } else if (file.sourceUrl) {
      const url = 'https://threeui.com' + file.sourceUrl;
      console.log('Downloading file:', file.path, 'from', url);
      buf = await fetchUrl(url);
    }
    fs.writeFileSync(fullPath, buf);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const matched = hash === file.sha256;
    console.log(file.path, 'matched:', matched, 'size:', buf.length, 'expected:', file.bytes);
    if (!matched) throw new Error('Hash mismatch for ' + file.path);
  }

  console.log('--- Processing Assets ---');
  for (const asset of data.assets) {
    const fullPath = path.resolve(asset.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const url = 'https://threeui.com/' + asset.path.replace(/^public\//, '');
    console.log('Downloading asset:', asset.path);
    const buf = await fetchUrl(url);
    fs.writeFileSync(fullPath, buf);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const matched = hash === asset.sha256;
    console.log(asset.path, 'matched:', matched, 'size:', buf.length, 'expected:', asset.bytes);
    if (!matched) throw new Error('Hash mismatch for asset ' + asset.path);
  }

  console.log('SUCCESS: All files and assets written and verified!');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
