'use strict';

/**
 * Generates a realistic mock dataset for today's UK greyhound racing card.
 * All dog names, trainers, and form strings are fictional but representative.
 *
 * Bookmaker odds are derived deterministically from each runner's opening price
 * using per-bookmaker margin factors, so the demo data is stable across reloads.
 */

// UK standard trap jacket colours
const TRAP_COLOURS = {
  1: { bg: '#cc0000', fg: '#ffffff', label: 'Red' },
  2: { bg: '#1a47a0', fg: '#ffffff', label: 'Blue' },
  3: { bg: '#f5f5f5', fg: '#222222', label: 'White' },
  4: { bg: '#1a1a1a', fg: '#ffffff', label: 'Black' },
  5: { bg: '#e87c00', fg: '#ffffff', label: 'Orange' },
  6: { bg: '#1a1a1a', fg: '#ffffff', label: 'B/W Stripe', stripe: true },
};

// Fixed margin factors per bookmaker (bookies always shade vs exchange)
const BOOKMAKERS = [
  { name: 'Bet365',       factor: 0.94 },
  { name: 'William Hill', factor: 0.91 },
  { name: 'Ladbrokes',    factor: 0.92 },
  { name: 'Paddy Power',  factor: 0.90 },
  { name: 'Sky Bet',      factor: 0.93 },
];

function makeMockBookieOdds(openingOdds) {
  const odds = BOOKMAKERS.map(bm => ({
    bookmakerName: bm.name,
    price: Math.max(1.01, parseFloat((openingOdds * bm.factor).toFixed(2))),
  }));
  odds.sort((a, b) => b.price - a.price);
  return { bestBookmakerOdds: odds[0], allBookmakerOdds: odds };
}

function makeRunner(trap, name, trainer, form, openingOdds, drift = 0, tipSources = [], tipPositions = null, starRating = null) {
  const currentOdds = parseFloat((openingOdds + drift).toFixed(2));
  const { bestBookmakerOdds, allBookmakerOdds } = makeMockBookieOdds(openingOdds);
  // Auto-fill positions: 1st for all sources unless explicitly provided
  const resolvedPositions = tipPositions || Object.fromEntries(tipSources.map(s => [s, 1]));

  return {
    trap,
    name,
    trainer,
    form,
    openingOdds,
    currentOdds,
    bestBookmakerOdds,
    allBookmakerOdds,
    tipSources,
    tipsCount:         tipSources.length,
    tipPositions:      resolvedPositions,
    isTipped:          Object.values(resolvedPositions).filter(p => p === 1).length >= 2,
    isBestBet:         Object.values(resolvedPositions).filter(p => p === 1).length >= 2 && currentOdds > openingOdds,
    isEachWayOutsider: tipSources.length >= 1 && currentOdds >= 7.0,
    starRating,
    trapColour: TRAP_COLOURS[trap],
  };
}

function generateMockRaces() {
  const today = new Date().toISOString().split('T')[0];

  return [
    // ── ROMFORD ───────────────────────────────────────────────────────────────
    {
      id: 'ROM-1430', venue: 'Romford', time: '14:30', date: today,
      distance: '400m', grade: 'A4', prize: '£210',
      runners: [
        makeRunner(1, 'Skywalker Turbo',  'J. Mullins',  '1-2-1-3-2', 4.50, +0.80, ['timeform', 'olbg', 'racingpost'], { timeform: 1, olbg: 2, racingpost: 1 }, 4),
        makeRunner(2, 'Droopys Senator',  'C. Buckland', '3-1-2-4-1', 3.20,  0.00, ['timeform'], { timeform: 1 }, 3),
        makeRunner(3, 'Ballymac Quest',   'S. Cahill',   '2-3-4-2-3', 6.00, -0.50, [], null, 2),
        makeRunner(4, 'Headford Tiger',   'P. Young',    '4-5-3-1-4', 8.00, +1.00, [], null, 2),
        makeRunner(5, 'Antigua Sunset',   'D. Dark',     '1-1-2-3-1', 2.80,  0.00, ['olbg'], { olbg: 2 }, 5),
        makeRunner(6, 'Greenpark Ivy',    'M. Wallis',   '5-4-5-6-5', 14.00,-1.00, [], null, 1),
      ],
    },
    {
      id: 'ROM-1500', venue: 'Romford', time: '15:00', date: today,
      distance: '575m', grade: 'S4', prize: '£250',
      runners: [
        makeRunner(1, 'Celtic Whirlwind', 'A. Samuels',  '2-1-3-2-1', 3.75,  0.00, ['olbg'], { olbg: 1 }),
        makeRunner(2, 'Ballybeg Diamond', 'B. Sheridan', '1-3-2-1-3', 4.00, +0.50, ['timeform', 'olbg'], { timeform: 1, olbg: 2 }),
        makeRunner(3, 'Swift Typhoon',    'J. Mullins',  '4-2-1-4-2', 5.50, +1.25, []),
        makeRunner(4, 'Romeo Magico',     'C. Buckland', '3-4-3-3-4', 7.00,  0.00, []),
        makeRunner(5, 'Fire Angel',       'S. Cahill',   '2-2-1-2-2', 3.25,  0.00, ['timeform'], { timeform: 2 }),
        makeRunner(6, 'Lenson Bocko',     'P. Young',    '1-1-4-1-1', 2.50, -0.25, []),
      ],
    },
    {
      id: 'ROM-1525', venue: 'Romford', time: '15:25', date: today,
      distance: '400m', grade: 'A3', prize: '£275',
      runners: [
        makeRunner(1, 'Midnight Cruiser', 'D. Dark',     '3-3-2-3-3', 5.00,  0.00, []),
        makeRunner(2, 'Razldazl George',  'M. Wallis',   '1-2-1-2-1', 2.60, -0.20, ['timeform'], { timeform: 1 }),
        makeRunner(3, 'Outdoor Survivor', 'A. Samuels',  '4-1-3-4-2', 6.50, +0.75, ['timeform', 'olbg'], { timeform: 1, olbg: 2 }),
        makeRunner(4, 'Nolas Legacy',     'B. Sheridan', '2-4-4-1-3', 4.50,  0.00, ['olbg'], { olbg: 2 }),
        makeRunner(5, 'Beaming Maygol',   'J. Mullins',  '5-3-5-5-4', 12.00,+2.00, []),
        makeRunner(6, 'Ballymac Eske',    'C. Buckland', '1-1-2-1-2', 2.80,  0.00, []),
      ],
    },

    // ── SHEFFIELD ─────────────────────────────────────────────────────────────
    {
      id: 'SHE-1445', venue: 'Sheffield', time: '14:45', date: today,
      distance: '480m', grade: 'A5', prize: '£185',
      runners: [
        makeRunner(1, 'Springside Harry', 'S. Cahill',   '2-3-4-2-3', 6.00,  0.00, []),
        makeRunner(2, 'Droopys Jet',      'P. Young',    '1-1-2-1-2', 2.90, -0.10, ['timeform', 'olbg'], { timeform: 1, olbg: 1 }),
        makeRunner(3, 'Antigua Star',     'D. Dark',     '3-2-3-3-1', 4.50, +1.00, []),
        makeRunner(4, 'Ballybeg Storm',   'M. Wallis',   '4-4-1-4-3', 7.50, +0.50, ['olbg'], { olbg: 2 }),
        makeRunner(5, 'Senahel Fox',      'A. Samuels',  '2-2-3-2-2', 3.60,  0.00, ['timeform'], { timeform: 2 }),
        makeRunner(6, 'Slippy Wizard',    'B. Sheridan', '1-3-2-1-4', 5.00,  0.00, []),
      ],
    },
    {
      id: 'SHE-1515', venue: 'Sheffield', time: '15:15', date: today,
      distance: '480m', grade: 'A4', prize: '£210',
      runners: [
        makeRunner(1, 'Pennys Whisper',   'J. Mullins',  '1-2-2-1-1', 3.00,  0.00, ['olbg'], { olbg: 1 }),
        makeRunner(2, 'Toolmaker Jack',   'C. Buckland', '3-3-3-4-3', 8.00, +1.50, ['timeform', 'olbg'], { timeform: 2, olbg: 1 }),
        makeRunner(3, 'Cedar Star',       'S. Cahill',   '2-1-1-2-2', 2.80,  0.00, []),
        makeRunner(4, 'Freewheel Gunner', 'P. Young',    '4-5-4-3-4', 10.00,-1.50, []),
        makeRunner(5, 'Knockduff Magnet', 'D. Dark',     '1-3-3-1-3', 4.75, +0.25, ['timeform'], { timeform: 2 }),
        makeRunner(6, 'Aayamza Priya',    'M. Wallis',   '2-2-1-3-1', 3.50,  0.00, []),
      ],
    },
    {
      id: 'SHE-1545', venue: 'Sheffield', time: '15:45', date: today,
      distance: '630m', grade: 'S5', prize: '£200',
      runners: [
        makeRunner(1, 'Tyrap Turbo',      'A. Samuels',  '3-4-2-3-2', 5.50,  0.00, []),
        makeRunner(2, 'Greenpark Zeus',   'B. Sheridan', '1-1-3-1-1', 2.60, -0.30, ['timeform'], { timeform: 1 }),
        makeRunner(3, 'Magical Bex',      'J. Mullins',  '2-2-1-2-3', 3.80, +0.70, ['timeform', 'olbg'], { timeform: 2, olbg: 1 }),
        makeRunner(4, 'Ballymac Bose',    'C. Buckland', '4-3-4-4-2', 7.00,  0.00, ['olbg'], { olbg: 2 }),
        makeRunner(5, 'Laurdella Fox',    'S. Cahill',   '2-1-2-1-1', 2.80,  0.00, []),
        makeRunner(6, 'Dinnys Delight',   'P. Young',    '5-6-5-5-6', 20.00,+3.00, []),
      ],
    },

    // ── NOTTINGHAM ────────────────────────────────────────────────────────────
    {
      id: 'NOT-1420', venue: 'Nottingham', time: '14:20', date: today,
      distance: '450m', grade: 'A6', prize: '£155',
      runners: [
        makeRunner(1, 'Coppice Tiger',    'D. Dark',     '3-2-4-3-2', 5.00, +0.50, ['timeform', 'olbg', 'racingpost'], { timeform: 1, olbg: 1, racingpost: 2 }),
        makeRunner(2, 'Killeacle Petal',  'M. Wallis',   '2-1-2-2-1', 3.20,  0.00, ['timeform'], { timeform: 2 }),
        makeRunner(3, 'Droopys Ricky',    'A. Samuels',  '1-3-1-1-3', 2.90,  0.00, []),
        makeRunner(4, 'Blonde Bombshell', 'B. Sheridan', '4-4-3-4-4', 9.00, -1.00, []),
        makeRunner(5, 'Silverhill Ava',   'J. Mullins',  '2-2-2-3-2', 3.75,  0.00, ['olbg'], { olbg: 2 }),
        makeRunner(6, 'Boher Roibeard',   'C. Buckland', '5-5-5-5-5', 16.00,+2.00, []),
      ],
    },
    {
      id: 'NOT-1450', venue: 'Nottingham', time: '14:50', date: today,
      distance: '480m', grade: 'S5', prize: '£185',
      runners: [
        makeRunner(1, 'Waikiki Wanda',    'S. Cahill',   '1-1-2-2-1', 3.40,  0.00, []),
        makeRunner(2, 'Burgess Remus',    'P. Young',    '3-3-1-3-3', 6.00, +1.20, ['timeform', 'olbg'], { timeform: 2, olbg: 1 }),
        makeRunner(3, 'Slippy Harold',    'D. Dark',     '2-2-3-1-2', 4.00,  0.00, ['olbg'], { olbg: 1 }),
        makeRunner(4, 'Newinn Power',     'M. Wallis',   '4-4-4-4-4', 11.00,-2.00, []),
        makeRunner(5, 'Aero Majestic',    'A. Samuels',  '1-2-1-2-1', 2.75, -0.25, ['timeform'], { timeform: 1 }),
        makeRunner(6, 'Heres Barry',      'B. Sheridan', '3-1-3-3-2', 5.50, +0.50, []),
      ],
    },

    // ── HOVE ──────────────────────────────────────────────────────────────────
    {
      id: 'HOV-1505', venue: 'Hove', time: '15:05', date: today,
      distance: '515m', grade: 'A4', prize: '£210',
      runners: [
        makeRunner(1, 'Puttfor Teddi',    'J. Mullins',  '2-3-2-2-3', 4.80,  0.00, ['olbg'], { olbg: 1 }),
        makeRunner(2, 'Gentle Ranger',    'C. Buckland', '1-2-1-1-1', 2.70,  0.00, []),
        makeRunner(3, 'Ballymac Posh',    'S. Cahill',   '3-1-3-3-2', 5.20, +1.30, ['timeform', 'olbg', 'racingpost'], { timeform: 1, olbg: 1, racingpost: 2 }),
        makeRunner(4, 'Sparta Thunder',   'P. Young',    '4-4-4-4-4', 10.00,+1.00, []),
        makeRunner(5, 'Crystal Glory',    'D. Dark',     '1-3-2-1-3', 3.60,  0.00, ['timeform'], { timeform: 1 }),
        makeRunner(6, 'Mustang Magpie',   'M. Wallis',   '2-2-3-2-2', 4.50,  0.00, []),
      ],
    },
    {
      id: 'HOV-1535', venue: 'Hove', time: '15:35', date: today,
      distance: '515m', grade: 'A3', prize: '£275',
      runners: [
        makeRunner(1, 'Kinloch Brae',     'A. Samuels',  '1-1-1-2-1', 2.50,  0.00, ['timeform'], { timeform: 1 }),
        makeRunner(2, 'Makeit Monalisa',  'B. Sheridan', '3-2-2-3-2', 4.20, +0.80, ['timeform', 'olbg', 'racingpost'], { timeform: 2, olbg: 1, racingpost: 1 }),
        makeRunner(3, 'Swithins Rex',     'J. Mullins',  '2-3-3-1-3', 5.50,  0.00, []),
        makeRunner(4, 'Droopys Maldini',  'C. Buckland', '4-4-1-4-4', 8.50, -1.50, ['olbg'], { olbg: 2 }),
        makeRunner(5, 'Deanridge Viking', 'S. Cahill',   '1-2-2-2-1', 3.20,  0.00, []),
        makeRunner(6, 'Ashbourne Lass',   'P. Young',    '5-5-4-5-5', 14.00,+3.00, []),
      ],
    },
  ];
}

module.exports = { generateMockRaces, TRAP_COLOURS };
