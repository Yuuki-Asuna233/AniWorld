const TIME_ZONE = 'Asia/Hong_Kong';
const OFFSET_MS = 8 * 60 * 60 * 1000;
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function hkDateParts(date = new Date()) {
  return Object.fromEntries(formatter.formatToParts(date)
    .filter(part => ['year', 'month', 'day'].includes(part.type)).map(part => [part.type, Number(part.value)]));
}
function hkWeekday(date = new Date()) {
  const { year, month, day } = hkDateParts(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
function nextWeeklyClock(weekday, hour, minute, now = new Date()) {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !Number.isInteger(hour)
    || hour < 0 || hour > 47 || !Number.isInteger(minute) || minute < 0 || minute > 59) return 0;
  const { year, month, day } = hkDateParts(now);
  const normalizedDay = (weekday + Math.floor(hour / 24)) % 7;
  const delta = (normalizedDay - hkWeekday(now) + 7) % 7;
  let value = Date.UTC(year, month - 1, day + delta, hour % 24, minute) - OFFSET_MS;
  if (value <= now.getTime()) value += 7 * 86400000;
  return Math.floor(value / 1000);
}
module.exports = { TIME_ZONE, OFFSET_MS, hkDateParts, hkWeekday, nextWeeklyClock };
