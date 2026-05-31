const cron = require('node-cron');
const { buildPrompt } = require('./context');
const { callClaude } = require('./claude');
const { setPref } = require('./state');
const { currentTimeContext } = require('./env-context');

let broadcastFn = null;
let triggerFn = null;  // runRadioSegment from server.js

function init(broadcast, trigger) {
  broadcastFn = broadcast;
  triggerFn = trigger;

  // 07:00 — generate today's plan (data only, no music trigger)
  cron.schedule('0 7 * * *', async () => {
    console.log('[调度] 07:00 生成今日节目规划…');
    try {
      const prompt = buildPrompt(
        'Generate a full-day radio plan: time slots, mood arcs, and representative tracks for each block.',
        ''
      );
      const result = await callClaude(prompt);
      setPref('today_plan', result);
      if (broadcastFn) broadcastFn({ type: 'plan', data: result });
      console.log('[调度] 今日规划已生成并保存');
    } catch (err) {
      console.error('[调度] 今日规划生成失败:', err.message);
    }
  });

  // 09:00 — morning show opens, actually plays music
  cron.schedule('0 9 * * *', async () => {
    if (!triggerFn) return;
    const moment = currentTimeContext();
    console.log(`[调度] 09:00 晨间开播 (${moment.weekday})…`);
    try {
      await triggerFn(
        `Good morning — it's 9am on ${moment.date}. Open the station. `
        + `Pick something that eases into the day without forcing the mood. 2–3 tracks.`,
        { mode: 'music', source: 'scheduler' },
        true
      );
    } catch (err) {
      console.error('[调度] 晨间开播失败:', err.message);
    }
  });

  // Every hour — vibe check: hold direction or shift, Claude decides
  cron.schedule('0 * * * *', async () => {
    if (!triggerFn) return;
    const moment = currentTimeContext();
    const hour = moment.hour;
    if (hour === 9) return; // morning already handled above
    console.log(`[调度] ${hour}:00 整点情绪检查…`);
    try {
      await triggerFn(
        `It's ${moment.time} on ${moment.date}. Check the station. Based on the time and recent play history, `
        + `decide whether to hold the current direction or bring in a new set. `
        + `If the vibe still fits, say something brief and keep going. `
        + `If it's time to shift, pick a fresh set that fits the new moment.`,
        { mode: 'music', source: 'scheduler' },
        true
      );
    } catch (err) {
      console.error(`[调度] ${hour}:00 情绪检查失败:`, err.message);
    }
  });

  console.log('[调度] 定时任务已注册 — 调度器接管电台主控');
}

module.exports = { init };
