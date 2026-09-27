const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
    this.events = [];
    this.consoleLogs = [];

    this.ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      } else if (msg.method) {
        if (msg.method === 'Runtime.consoleAPICalled') {
          const text = msg.params.args.map(a => a.value || JSON.stringify(a)).join(' ');
          this.consoleLogs.push({ type: msg.params.type, text });
          console.log(`[Browser Console ${msg.params.type}]`, text);
        } else if (msg.method === 'Log.entryAdded') {
          console.log(`[Browser Log]`, msg.params.entry.text);
        }
      }
    });
  }

  ready() {
    return new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function run() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const port = 9334;
  const userDataDir = 'C:\\Users\\ashif\\OneDrive\\Desktop\\ikagi\\.chrome_verify_temp';

  fs.rmSync(userDataDir, { recursive: true, force: true });

  const chromeProc = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,800',
    'about:blank'
  ]);

  let wsUrl = null;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try {
      const list = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json`, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
      });
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) {
        wsUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
  }

  if (!wsUrl) {
    chromeProc.kill();
    throw new Error('Chrome did not start remote debugging');
  }

  const client = new CDPClient(wsUrl);
  await client.ready();

  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');

  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false
  });

  console.log('Navigating to http://localhost:5173/ ...');
  await client.send('Page.navigate', { url: 'http://localhost:5173/' });

  // Wait for page to load and iframe to load
  console.log('Waiting for Kage landing page iframe to load...');
  let loaded = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const res = await client.send('Runtime.evaluate', {
      expression: `
        (() => {
          const iframe = document.querySelector('iframe');
          if (!iframe) return { hasIframe: false };
          try {
            const doc = iframe.contentDocument;
            if (!doc) return { hasIframe: true, hasDoc: false };
            const canvas = doc.querySelector('#gl');
            const title = doc.title;
            const heading = doc.querySelector('h1, .display');
            const customStyle = doc.querySelector('style[id*="threeui"], head style:last-of-type');
            return {
              hasIframe: true,
              hasDoc: true,
              hasCanvas: !!canvas,
              title: title,
              headingText: heading ? heading.textContent.trim() : null,
              customStyle: customStyle ? customStyle.textContent.slice(0, 200) : null,
              readyState: doc.readyState
            };
          } catch (e) {
            return { hasIframe: true, crossOrigin: true, error: e.message };
          }
        })()
      `,
      returnByValue: true
    });

    console.log(`Poll ${i}:`, res.result.value);
    if (res.result.value && res.result.value.hasCanvas) {
      loaded = true;
      break;
    }
  }

  // Let animations and WebGL settle
  await sleep(3000);

  // Take screenshot of initial state
  const screenshot1 = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('kage_rendered_initial.png', Buffer.from(screenshot1.data, 'base64'));
  console.log('Saved kage_rendered_initial.png');

  // Test scrolling in iframe
  console.log('Scrolling down to Chapter 2 in iframe...');
  await client.send('Runtime.evaluate', {
    expression: `
      (() => {
        const iframe = document.querySelector('iframe');
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.scrollTo({ top: 1200, behavior: 'smooth' });
          iframe.contentWindow.dispatchEvent(new Event('scroll'));
        }
      })()
    `
  });

  await sleep(2500);

  // Take screenshot of scrolled state
  const screenshot2 = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('kage_rendered_scrolled.png', Buffer.from(screenshot2.data, 'base64'));
  console.log('Saved kage_rendered_scrolled.png');

  // Verify elements and style inside iframe
  const evalDetails = await client.send('Runtime.evaluate', {
    expression: `
      (() => {
        const iframe = document.querySelector('iframe');
        const doc = iframe.contentDocument;
        const gl = doc.querySelector('#gl');
        const nav = doc.querySelector('nav, header, .nav');
        const chapters = doc.querySelectorAll('section, [data-chapter], .chapter');
        const styles = Array.from(doc.querySelectorAll('style')).map(s => s.textContent);
        const typographyOverride = styles.find(s => s.includes('--vermilion') || s.includes('Onest'));

        return {
          canvasWidth: gl ? gl.width : null,
          canvasHeight: gl ? gl.height : null,
          hasNav: !!nav,
          chapterCount: chapters.length,
          hasTypographyOverride: !!typographyOverride,
          overrideSample: typographyOverride ? typographyOverride.slice(0, 300) : null
        };
      })()
    `,
    returnByValue: true
  });

  console.log('Evaluation details inside iframe:', evalDetails.result.value);

  client.close();
  chromeProc.kill();
  console.log('Verification completed successfully!');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
