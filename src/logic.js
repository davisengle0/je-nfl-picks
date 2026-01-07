export function isLocked(roundLockUtc) {
  if (!roundLockUtc) return false;
  return Date.now() >= Date.parse(roundLockUtc);
}

export function winnerTeamName(m, side) {
  if (!m) return "";
  return side === "A" ? m.team_a : m.team_b;
}

export function computeLeaderboard(entries, matchups, picks) {
  // 1 point per correct pick for matchups that have a winner set.
  const winnersByMatchup = new Map(
    matchups
      .filter(m => m.winner === "A" || m.winner === "B")
      .map(m => [m.id, m.winner])
  );

  const scoreByEntry = new Map(entries.map(e => [e.id, 0]));

  for (const p of picks) {
    const w = winnersByMatchup.get(p.matchup_id);
    if (!w) continue;
    if (p.picked === w) {
      scoreByEntry.set(p.entry_id, (scoreByEntry.get(p.entry_id) || 0) + 1);
    }
  }

  const rows = entries.map(e => ({
    entry_id: e.id,
    name: `${e.first_name} ${e.last_name}`,
    points: scoreByEntry.get(e.id) || 0
  }));

  rows.sort((a,b) => b.points - a.points || a.name.localeCompare(b.name));
  return rows;
}

export function computeMatchupStats(matchup, entries, picksForMatchup) {
  const total = picksForMatchup.length;

  const entryById = new Map(entries.map(e => [e.id, e]));
  const aPickers = [];
  const bPickers = [];

  for (const p of picksForMatchup) {
    const e = entryById.get(p.entry_id);
    const nm = e ? `${e.first_name} ${e.last_name}` : "Unknown";
    if (p.picked === "A") aPickers.push(nm);
    if (p.picked === "B") bPickers.push(nm);
  }

  aPickers.sort();
  bPickers.sort();

  const aCount = aPickers.length;
  const bCount = bPickers.length;

  const pct = (n) => total === 0 ? 0 : Math.round((n / total) * 100);

  return {
    total,
    aCount,
    bCount,
    aPct: pct(aCount),
    bPct: pct(bCount),
    aPickers,
    bPickers
  };
}
