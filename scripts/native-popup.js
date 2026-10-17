import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

// Keep one session for the native target: key down/up and media emulation must
// share its lifetime. A popup.html tab is never a substitute for this target.
export async function nativePopupSession(context, targetId) {
  assert.ok(targetId, 'native toolbar popup target was identified when opened');
  const connection = await context.browser().newBrowserCDPSession();
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: false });
  let sequence = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => finish(new Error(`Native popup command timed out: ${method}`)), 10000);
    const receive = event => {
      if (event.sessionId !== sessionId) return;
      const response = JSON.parse(event.message);
      if (response.id !== id) return;
      finish(response.error ? new Error(response.error.message) : null, response.result);
    };
    function finish(error, result) {
      clearTimeout(timeout);
      connection.off('Target.receivedMessageFromTarget', receive);
      if (error) reject(error); else resolve(result);
    }
    connection.on('Target.receivedMessageFromTarget', receive);
    connection.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(finish);
  });
  return {
    send,
    async screenshot(path) {
      const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(path, Buffer.from(result.data, 'base64'));
    },
    async close() {
      // The popup may already have closed through its native host.
      await connection.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      await connection.detach();
    }
  };
}
