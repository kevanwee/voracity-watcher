import { expect, it } from 'vitest';
import { telegramCall } from '../src/telegram.ts';

it('accepts an already-applied edit but rejects other Telegram failures', async () => {
  const unchanged = async () => new Response(JSON.stringify({ ok: false, error_code: 400,
    description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' }), { status: 400 });
  await expect(telegramCall('synthetic', 'editMessageText', {}, unchanged)).resolves.toBeInstanceOf(Response);
  await expect(telegramCall('synthetic', 'sendMessage', {}, unchanged)).rejects.toThrow();
  const forbidden = async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }), { status: 400 });
  await expect(telegramCall('synthetic', 'editMessageText', {}, forbidden)).rejects.toThrow();
  await expect(telegramCall('synthetic', 'sendMessage', {}, async () => new Response('{"ok":false}'))).rejects.toThrow();
  await expect(telegramCall('synthetic', 'sendMessage', {}, async () => new Response('not JSON'))).rejects.toThrow();
});
