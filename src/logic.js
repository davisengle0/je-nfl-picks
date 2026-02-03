// src/logic.js

export function isLocked(roundLockUtc) {
  if (!roundLockUtc) return false;
  const t = new Date(roundLockUtc).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() >= t;
}

/**
 * computeLeaderboard
 * - Primary: points desc
 * - Tie-break (ONLY when Super Bowl actual total exists): abs(guess - actual_total) asc
 * - Final: name asc
 *
 * Returns rows with:
 * { entry_id, name, points, sb_guess, sb_diff, tb_active }
 */
export function computeLeaderboard(entries, matchups, picks) {
  const entryById = new Map();
  for (const e of entries || []) entryById.set(e.id, e);

  const matchupById = new Map();
  for (const m of matchups || []) matchupById.set(m.id, m);

  // Find Super Bowl matchup + actual total points (only if scores are entered)
  const sbMatchup = (matchups || []).find((m) => m.round_name === "Super Bowl");
  const sbActualTotal =
    sbMatchup && sbMatchup.score_a != null && sbMatchup.score_b != null
      ? Number(sbMatchup.score_a) + Number(sbMatchup.score_b)
      : null;

  const tbActive = sbActualTotal != null;

  // Points by entry
  const pointsByEntry = new Map();
  for (const e of entries || []) pointsByEntry.set(e.id, 0);

  for (const p of picks || []) {
    const m = matchupById.get(p.matchup_id);
    if (!m || !m.winner) continue;
    if (p.picked === m.winner) {
      pointsByEntry.set(p.entry_id, (pointsByEntry.get(p.entry_id) || 0) + 1);
    }
  }

  const rows = (entries || []).map((e) => {
    const pts = Number(pointsByEntry.get(e.id) || 0);

    const guessRaw = e.sb_total_points_guess;
    const guess = guessRaw == null || guessRaw === "" ? null : Number(guessRaw);

    const diff =
      !tbActive || guess == null || Number.isNaN(guess)
        ? null
        : Math.abs(guess - sbActualTotal);

    return {
      entry_id: e.id,
      name: `${e.first_name} ${e.last_name}`.trim(),
      points: pts,
      sb_guess: guess,
      sb_diff: diff,
      tb_active: tbActive
    };
  });

  rows.sort((a, b) => {
    // 1) points desc
    if (b.points !== a.points) return b.points - a.points;

    // 2) tiebreak only after SB total exists
    if (tbActive) {
      const aDiff = a.sb_diff == null ? Number.POSITIVE_INFINITY : a.sb_diff;
      const bDiff = b.sb_diff == null ? Number.POSITIVE_INFINITY : b.sb_diff;
      if (aDiff !== bDiff) return aDiff - bDiff;
    }

    // 3) stable last sort
    return a.name.localeCompare(b.name);
  });

  return rows;
}

/**
 * Matchup stats: % picked each side + names of pickers.
 * If opts.includeSbGuess is true AND matchup round is Super Bowl,
 * append guess after name like: "Davis Engle (47)"
 */
export function computeMatchupStats(matchup, entries, picksForMatchup, opts = {}) {
  const entryById = new Map();
  for (const e of entries || []) entryById.set(e.id, e);

  const aPickers = [];
  const bPickers = [];
  let aCount = 0;
  let bCount = 0;

  const isSuperBowl = matchup?.round_name === "Super Bowl";
  const showGuess = !!opts.includeSbGuess && isSuperBowl;

  for (const p of picksForMatchup || []) {
    const e = entryById.get(p.entry_id);
    if (!e) continue;

    let display = `${e.first_name} ${e.last_name}`.trim();
    if (showGuess) {
      const g = e.sb_total_points_guess;
      if (g != null && g !== "") display = `${display} (${g})`;
    }

    if (p.picked === "A") {
      aCount += 1;
      aPickers.push(display);
    } else if (p.picked === "B") {
      bCount += 1;
      bPickers.push(display);
    }
  }

  const total = aCount + bCount;
  const aPct = total ? Math.round((aCount / total) * 100) : 0;
  const bPct = total ? Math.round((bCount / total) * 100) : 0;

  aPickers.sort((x, y) => x.localeCompare(y));
  bPickers.sort((x, y) => x.localeCompare(y));

  return { aPct, bPct, aCount, bCount, aPickers, bPickers };
}
