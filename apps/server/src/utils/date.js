// Date & season utilities
const { hkDateParts, hkWeekday, nextWeeklyClock } = require('../../../../baiyu_agent/shared/business-time');

function getCurrentSeasonInfo() {
  const { year, month } = hkDateParts();
  let current, next;
  if (month <= 3)      { current = 'WINTER'; next = 'SPRING'; }
  else if (month <= 6) { current = 'SPRING'; next = 'SUMMER'; }
  else if (month <= 9) { current = 'SUMMER'; next = 'FALL'; }
  else                 { current = 'FALL'; next = 'WINTER'; }
  const nextYear = (current === 'FALL' && next === 'WINTER') ? year + 1 : year;
  return [
    { season: current, seasonYear: year },
    { season: next, seasonYear: nextYear }
  ];
}

function getSeasonSyncWindow() {
  const [current, next] = getCurrentSeasonInfo();
  const previousBySeason = {
    WINTER: { season: 'FALL', seasonYear: current.seasonYear - 1 },
    SPRING: { season: 'WINTER', seasonYear: current.seasonYear },
    SUMMER: { season: 'SPRING', seasonYear: current.seasonYear },
    FALL: { season: 'SUMMER', seasonYear: current.seasonYear }
  };
  return [previousBySeason[current.season], current, next];
}

module.exports = { getCurrentSeasonInfo, getSeasonSyncWindow, hkDateParts, hkWeekday, nextWeeklyClock };
