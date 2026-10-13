const { TIME_ZONE, hkDateParts } = require('./business-time');
const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

function hkDateKey(date = new Date()) {
  const { year, month, day } = hkDateParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function currentDateReference(date = new Date()) {
  const { year, month } = hkDateParts(date);
  const quarter = Math.floor((month - 1) / 3);
  return { date: hkDateKey(date), timeZone: TIME_ZONE, year, quarter: quarter + 1,
    season: SEASONS[quarter], seasonYear: year };
}

module.exports = { hkDateParts, hkDateKey, currentDateReference };
